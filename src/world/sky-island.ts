/**
 * SKYHAVEN — the flying town. Issue #68, and the first `CarrierInfo`: everything
 * generic about a moving piece of world lives in world/carriers.ts. The rock is a
 * voxel heightfield (shell only), the deck is a CONSTANT (`localDeck`) so drawn and
 * walkable agree by construction, and the town comes from world/sky-parts.ts.
 * Altitude, not avoidance, keeps it out of peaks — see `steer`.
 */
import * as THREE from "three";
import type { CelestialState, Mooring, TownInfo, TownRegistry } from "../core/types";
import { CarrierBody } from "./carriers";
import type { PropLib } from "./props";
import { Accum, bakeProp, type Template } from "./props";
import { SolidStamp, StructureField } from "./structures";
import { Npcs, type NpcFrame, type NpcSite } from "./npc";
import { RoadNetwork, type Road } from "./roads";
import { flagstoneProfile } from "./path-profile";
import { VoxelModel } from "../core/voxel";
import { mulberry32 } from "./noise";
import { flags } from "../core/flags";
import { Waterfall } from "./waterfall";
import {
  skyBush,
  skyCottage,
  skyFence,
  skyGate,
  skyLamp,
  skySmoke,
  skyStall,
  skyTower,
  skyWell,
} from "./sky-parts";
import { CARRIED_LAYOUT_KIND, content, defineFactory, type TownData } from "../content";
import { displayKey } from "../core/content-bridge";
import type { Terrain } from "./terrain";
import { WATER_LEVEL } from "./terrain";
import { createCarriedWaterMaterial } from "./water";
import {
  CELL,
  CLIFF,
  LEDGE,
  LIP_COURSES,
  RIM_STONE,
  hash2,
  lipAt,
  paintShellColumn,
} from "./sky-rock";

/** World units per terrain voxel. Twice sky-parts' `SV` (0.6): a cottage wall is
 * two courses to a cliff's one, and column count grows as its square. */
/** Cells per block of the authored plan, which is drawn at a coarser gauge than the
 * rock is built at, so the layout reads in whole blocks and the coast stays fine. */
const MAP_BLOCK = 3;

/** The island's radius in MAP BLOCKS. 26 makes it 52 across, which is the plan. */
const MAP_R = 26;

export const ISLAND_R = MAP_R * MAP_BLOCK * CELL;

const RC = ISLAND_R / CELL;

/** Extra keel depth at the middle, in courses. CLIFF + TAPER is what the silhouette
 * AND the flight rule read (`KEEL` is its world-unit form) — move one, move the other. */
const TAPER = 58;

const KEEL = (CLIFF + TAPER) * CELL;

/** Published so the cloud deck knows how far under the deck to pass. */
export const ISLAND_KEEL = KEEL;

/** Grey rim-stone collar width, in cells, in from the outline — the cliff's top seen
 * end-on, so it takes the cliff's own stone. 5.1% of `RC` per the plan's scan. */
/** Published so the shards keep out of the disc an island may roam into. */
export const ROAM_R = 260;
/** Cruise speed, world units/s. Must stay far under the hero's 6 — it has to be catchable. */
const CRUISE = 1.0;
const TURN_LAMBDA = 0.22;
const YAW_RATE = 0.03;
const ARRIVE = 26;

/** Keel clearance over the highest ground below. Large: the sample set is finite. */
const KEEL_MARGIN = 14;
/** Altitude floor. 190 clears the cumulus bands (80-142, world/clouds.ts). */
const MIN_ALT = 190;
const MAX_ALT = 215;
const CLIMB_RATE = 1.6;

/** How far AHEAD the island samples ground, as a multiple of its own radius. */
const LOOK_AHEAD = 2;

/** Water plane height over the deck. The deck is local 0: sinking the channel a cube
 * would be a 1.2 wall against a `MAX_STEP_UP` of 0.5, so the stream is a FILM. */
const STREAM_LIFT = 0.09;
/** Channel depth handed to the shader: fully in water.ts's shallow stop, bed legible. */
const STREAM_DEPTH = 0.75;

/** WHERE EVERYTHING GOES, in the island's frame. Planned before the rock, because the
 * paths are flagstones painted INTO the terrain. */
interface SkyPlan {
  readonly buildings: ReadonlyArray<{
    t: Template;
    x: number;
    z: number;
    yaw: number;
    s?: number;
    /** Facade distance and light height for the separate night-only layer. */
    light?: readonly [front: number, height: number];
  }>;
  /** Path centrelines as [x0, z0, x1, z1], painted into the turf. */
  readonly paths: ReadonlyArray<readonly [number, number, number, number]>;
  /** The same streets as a queryable network — the planter needs it. See `streetNetwork`. */
  readonly streets: RoadNetwork;
  readonly lamps: ReadonlyArray<{ x: number; z: number; yaw: number }>;
  readonly fences: ReadonlyArray<{ x: number; z: number; yaw: number }>;
  readonly trees: ReadonlyArray<{ t: Template; x: number; z: number; yaw: number; s: number }>;
  /** Canal stones down both banks of the stream. Issue #89. */
  readonly rocks: ReadonlyArray<{ t: Template; x: number; z: number; yaw: number; s: number }>;
  readonly plots: ReadonlyArray<{ x: number; z: number; r: number }>;
  /** Bearing the stream leaves on, and where its pool sits. */
  readonly fallAngle: number;
  /** The town square — what an NPC stands across from. */
  readonly focus: { x: number; z: number };
  /** The balloon's berth: the pad the hero boards from and where the craft waits. */
  readonly mooring: { x: number; z: number; boatX: number; boatZ: number };
}

/** The paved square. Nothing inside it but the tower and the market. */
const PLAZA = 19;
/** Half-width of a flagged street. One number for two jobs since issue #142: what
 * `buildRock` paints and what `streetNetwork` refuses are the same street. */
const PATH_HALF = 2.9;

/** Water width at the rim: the effect's `lipWidth` AND the channel's mouth, or
 * rim-stone shows either side of the plume where a player stands to look over. */
const FALL_LIP = MAP_BLOCK * 2 * CELL;

/**
 * THE CHANNEL as one function of a point: offset from the centreline, and the water's
 * half-width there. One source of truth for the bed, the surface, the bank stones and
 * the plan's claim (issue #89). Null before the head of the run. The mouth flares to
 * `FALL_LIP` plus a cell over the last THIRD of the run.
 */
function streamAt(
  fallAngle: number,
  wx: number,
  wz: number,
): { across: number; halfW: number } | null {
  const fx = Math.sin(fallAngle);
  const fz = Math.cos(fallAngle);
  const along = wx * fx + wz * fz;
  if (along < PLAZA * 0.7) {
    return null;
  }
  const t = Math.max(0, Math.min(1, (along - ISLAND_R * 0.66) / (ISLAND_R * 0.34)));
  const flare = t * t * (3 - 2 * t);
  return {
    across: Math.abs(wx * fz - wz * fx),
    halfW: 1.9 + flare * (FALL_LIP * 0.5 + CELL - 1.9),
  };
}

function onStream(fallAngle: number, wx: number, wz: number): boolean {
  const s = streamAt(fallAngle, wx, wz);
  return s !== null && s.across < s.halfW;
}

// The solid template bake keeps only root geometry, so the emissive children
// authored in sky-parts.ts need their own merged, non-colliding layer.
const SKY_WINDOW: Template = (() => {
  const v = new VoxelModel();
  v.box(-1, 0, 0, 0, 1, 0, 0xffc86a);
  return bakeProp(v, 0.28);
})();
const SKY_LANTERN: Template = (() => {
  const v = new VoxelModel();
  v.box(-1, -1, -1, 1, 1, 1, 0xffb84f);
  return bakeProp(v, 0.2);
})();
/** The band the dwellings stand in, as fractions of the island radius. */
const HOUSE_IN = 0.34;
const HOUSE_OUT = 0.62;
const TREE_RING = 0.74;
const CLUSTERS = 9;

/** A dwelling's footprint radius. Claim and test with the SAME number, or houses vanish. */
const HOUSE_R = 7.2;

/**
 * Lay the town out: a tower over a paved square, dwellings CLUSTERED around it,
 * streets, gardens, a tree line and a gate.
 *
 * @param onDeck Is there ground here? The outline is not a circle, so anything placed
 *   on a constant fraction of the radius hangs over the void.
 * @param rimAt The rim's world radius at a bearing, so the fence follows the coast.
 */
/** A point at a bearing and distance from the island's centre. */
const at = (a: number, d: number): [number, number] => [Math.sin(a) * d, Math.cos(a) * d];

function planSkyhaven(
  seed: number,
  parts: SkyParts,
  lib: PropLib,
  onDeck: (x: number, z: number) => boolean,
  rimAt: (bearing: number) => number,
): SkyPlan {
  const rng = mulberry32(seed ^ 0x5c17);
  const buildings: Array<{
    t: Template;
    x: number;
    z: number;
    yaw: number;
    s?: number;
    light?: readonly [front: number, height: number];
  }> = [];
  const paths: Array<readonly [number, number, number, number]> = [];
  const lamps: Array<{ x: number; z: number; yaw: number }> = [];
  const fences: Array<{ x: number; z: number; yaw: number }> = [];
  const trees: Array<{ t: Template; x: number; z: number; yaw: number; s: number }> = [];
  const rocks: Array<{ t: Template; x: number; z: number; yaw: number; s: number }> = [];
  const plots: Array<{ x: number; z: number; r: number }> = [];
  /** Everything already standing, so nothing is planted inside a wall. */
  const taken: Array<{ x: number; z: number; r: number }> = [];
  const free = (x: number, z: number, r: number): boolean =>
    !taken.some((t) => (t.x - x) ** 2 + (t.z - z) ** 2 < (t.r + r) ** 2);
  const claim = (x: number, z: number, r: number): void => {
    taken.push({ x, z, r });
  };

  buildings.push({ t: parts.tower, x: 0, z: 0, yaw: rng() * 6.28, s: 1.25, light: [3.8, 4.5] });
  claim(0, 0, 7);

  {
    const a = rng() * 6.28;
    const [wx, wz] = at(a, PLAZA * 0.68);
    buildings.push({ t: parts.well, x: wx, z: wz, yaw: rng() * 6.28 });
    claim(wx, wz, 3);
    for (const off of [2.2, 4.3]) {
      const [sx, sz] = at(a + off, PLAZA * 0.72);
      buildings.push({ t: parts.stall, x: sx, z: sz, yaw: a + off + Math.PI, light: [2.1, 2.4] });
      claim(sx, sz, 4);
    }
  }

  // Both rim bearings are decided BEFORE anything is planted (issue #89): the stream's
  // used to be last, so nothing placed above could be asked about the water.
  const a0 = rng() * 6.28;
  const gateAngle = a0 + Math.PI * 1.28;
  // The fall is on the front quarter, beside the gate, so both frame together.
  const fallAngle = gateAngle + Math.PI * 0.42;

  // A chain of discs down the centreline, so `free` refuses the stream to everything
  // that asks — the opening at the waterfall is therefore not a special case. The
  // stones go down first, in their own walk: interleaving let the channel claim its own
  // banks. `lib.rock*Moss` are the meadow's own pond boulders.
  {
    const stones = [lib.rockAMoss, lib.rockBMoss, lib.rockA, lib.rockB];
    const bx = Math.cos(fallAngle);
    const bz = -Math.sin(fallAngle);
    for (let d = PLAZA * 0.7; d <= ISLAND_R; d += 2.4) {
      const [cx, cz] = at(fallAngle, d);
      const s = streamAt(fallAngle, cx, cz);
      if (!s) {
        continue;
      }
      for (const side of [-1, 1]) {
        // On the bank, just outboard of the waterline, so the stone's foot is wet.
        const off = s.halfW + 0.6 + rng() * 0.5;
        const x = cx + bx * off * side;
        const z = cz + bz * off * side;
        if (!onDeck(x, z) || !free(x, z, 0.9)) {
          continue;
        }
        rocks.push({
          t: stones[Math.floor(rng() * stones.length)],
          x,
          z,
          yaw: rng() * 6.28,
          // Small: at the meadow's own scale these are a wall of erratics.
          s: 0.42 + rng() * 0.26,
        });
        claim(x, z, 0.9);
      }
    }
  }
  for (let d = PLAZA * 0.7; d <= ISLAND_R; d += 2.4) {
    const [cx, cz] = at(fallAngle, d);
    const s = streamAt(fallAngle, cx, cz);
    if (s) {
      claim(cx, cz, s.halfW + 2.4);
    }
  }

  let houses = 0;
  for (let c = 0; c < CLUSTERS; c++) {
    const centre = a0 + (c / CLUSTERS) * Math.PI * 2 + (rng() - 0.5) * 0.5;
    const dist = ISLAND_R * (HOUSE_IN + rng() * (HOUSE_OUT - HOUSE_IN));
    // ONE AXIS PER KNOT, quantised to an eighth turn, so every roof in a knot runs
    // the same way and only two or three axes appear on the island.
    const axis = Math.round((centre + Math.PI) / (Math.PI / 4)) * (Math.PI / 4);
    const count = 3 + Math.floor(rng() * 4);
    for (let k = 0; k < count; k++) {
      const along = (k - (count - 1) / 2) * (HOUSE_R * 2.1 + rng() * 4);
      const px = Math.sin(centre) * dist + Math.cos(centre) * along;
      const pz = Math.cos(centre) * dist - Math.sin(centre) * along;
      if (!free(px, pz, HOUSE_R)) {
        continue;
      }
      const kind = (houses % 3) as 0 | 1 | 2;
      // Alternating slate and shingle makes a knot read as separate buildings.
      buildings.push({
        // Stamped at 1.2: scaling the stamp keeps `SV`'s gauge and takes the collider.
        t: parts.cottages[kind + (houses % 2 === 0 ? 0 : 3)],
        x: px,
        z: pz,
        yaw: axis + (rng() - 0.5) * 0.12,
        s: 1.2,
        light: [3.7, 2.2],
      });
      claim(px, pz, HOUSE_R);
      houses++;
      const bx = px + Math.sin(centre) * (HOUSE_R + 1.6);
      const bz = pz + Math.cos(centre) * (HOUSE_R + 1.6);
      if (free(bx, bz, 2)) {
        buildings.push({ t: parts.bushes[houses % 2], x: bx, z: bz, yaw: rng() * 6.28 });
        claim(bx, bz, 2);
      }
      // No smoke: `skySmoke` at this gauge read as a pillar beside the cottage. Kept.
    }
    const [px0, pz0] = at(centre, PLAZA);
    const [px1, pz1] = at(centre, dist - 6);
    paths.push([px0, pz0, px1, pz1]);
    const [lx, lz] = at(centre + 0.12, (PLAZA + dist) * 0.5);
    if (free(lx, lz, 2)) {
      lamps.push({ x: lx, z: lz, yaw: centre });
      claim(lx, lz, 2);
    }
    // A garden plot in the gap after the knot, so the ground looks used.
    const [gx, gz] = at(centre + Math.PI / CLUSTERS, dist * 0.92);
    if (free(gx, gz, 6)) {
      plots.push({ x: gx, z: gz, r: 5.5 });
      claim(gx, gz, 6);
    }
  }

  // A ring road round the square, so the streets meet something.
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    const b = ((k + 1) / 16) * Math.PI * 2;
    const [x0, z0] = at(a, PLAZA);
    const [x1, z1] = at(b, PLAZA);
    paths.push([x0, z0, x1, z1]);
  }

  // The gate, out on the rim: it breaks the silhouette and says which side is front.
  // Walked inward until it stands on turf: the outline is not a circle, and one
  // seed's rim dips under 0.9 R on the gate's own bearing.
  {
    let gf = 0.9;
    while (gf > 0.6 && !onDeck(...at(gateAngle, ISLAND_R * gf))) {
      gf -= 0.03;
    }
    const [gx, gz] = at(gateAngle, ISLAND_R * gf);
    buildings.push({ t: parts.gate, x: gx, z: gz, yaw: gateAngle, s: 1.2, light: [1.6, 7.2] });
    claim(gx, gz, 8);
    const [p0x, p0z] = at(gateAngle, PLAZA);
    paths.push([p0x, p0z, gx, gz]);
  }

  // The mooring, beside the gate and off its street: where the balloon waits and
  // where the hero stands to board (issue #157). Walked inward until both the pad
  // and the craft stand on turf, since the outline is not a circle.
  const mooringAngle = gateAngle - 0.22;
  let mooring = { x: 0, z: 0, boatX: 0, boatZ: 0 };
  for (let f = 0.8; f > 0.4; f -= 0.04) {
    const [px, pz] = at(mooringAngle, ISLAND_R * f);
    const [bx, bz] = at(mooringAngle, ISLAND_R * (f + 0.07));
    if (onDeck(px, pz) && onDeck(bx, bz) && free(px, pz, 3) && free(bx, bz, 4)) {
      mooring = { x: px, z: pz, boatX: bx, boatZ: bz };
      claim(px, pz, 3);
      claim(bx, bz, 4);
      break;
    }
  }

  // Every street is planned by here, and must be before anything is PLANTED:
  // `free`/`claim` knows radii and a street is a line (issue #142 §1).
  const streets = streetNetwork(paths);
  /** Room to GROW, clear of every street. Not folded into `free`: lamps, the well and
   * the stalls stand ON a street on purpose. What a street refuses is foliage. */
  const offStreet = (x: number, z: number, r: number): boolean => streets.edgeDistanceTo(x, z) >= r;

  // The world's own oaks, not its pines (the snow variant reads as a bug up here).
  // Clumped and big: evenly spaced saplings made the island look smaller.
  const templates = [lib.oakA, lib.oakB, lib.oakC, lib.oakD];
  const woodAt = a0 + Math.PI * 0.55;
  for (let c = 0; c < 16; c++) {
    const centre = c < 8 ? woodAt + (c - 3.5) * 0.34 + (rng() - 0.5) * 0.3 : rng() * Math.PI * 2;
    const dist = ISLAND_R * TREE_RING + (rng() - 0.5) * ISLAND_R * 0.12;
    const n = 3 + Math.floor(rng() * 4);
    for (let k = 0; k < n; k++) {
      const a = centre + (rng() - 0.5) * 0.36;
      const d = dist + (rng() - 0.5) * 9;
      const [x, z] = at(a, d);
      if (!free(x, z, 4) || !offStreet(x, z, 4)) {
        continue;
      }
      trees.push({
        t: templates[Math.floor(rng() * templates.length)],
        x,
        z,
        yaw: rng() * 6.28,
        s: 0.85 + rng() * 0.35,
      });
      claim(x, z, 4);
    }
  }
  for (let k = 0; k < 8; k++) {
    const a = rng() * Math.PI * 2;
    const [x, z] = at(a, ISLAND_R * (0.2 + rng() * 0.3));
    if (!free(x, z, 5) || !offStreet(x, z, 5)) {
      continue;
    }
    trees.push({
      t: templates[Math.floor(rng() * templates.length)],
      x,
      z,
      yaw: rng() * 6.28,
      s: 0.9 + rng() * 0.3,
    });
    claim(x, z, 5);
  }
  for (let k = 0; k < 110; k++) {
    const a = rng() * Math.PI * 2;
    const [x, z] = at(a, ISLAND_R * (0.16 + rng() * 0.74));
    if (!free(x, z, 2.2) || !offStreet(x, z, 2.2)) {
      continue;
    }
    buildings.push({ t: parts.bushes[k % 2], x, z, yaw: rng() * 6.28 });
    claim(x, z, 2.2);
  }

  // ONE CONTINUOUS RAIL, WALKED ALONG THE ACTUAL COAST: panels on a constant radius
  // hang over the drop where `outlineAt` dips, and a constant angular step gets the
  // spacing wrong. Yaw is the direction of travel — `skyFence` paints along local +X,
  // which the stamp maps to world (cos yaw, -sin yaw), so `yaw = atan2(-uz, ux)`.
  {
    /** How far inside the coast the posts stand, in world units. */
    const INSET = 3.2;
    /** Panel length: 7 cells of `SV`, lapped a little so the joints close. */
    const SPACING = 7 * 0.6 * 0.94;
    const rimPt = (a: number): [number, number] => {
      const r = Math.max(2, rimAt(a) - INSET);
      return [Math.sin(a) * r, Math.cos(a) * r];
    };
    const STEPS = 720;
    let [lx, lz] = rimPt(0);
    for (let i = 1; i <= STEPS; i++) {
      const a = (i / STEPS) * Math.PI * 2;
      const [x, z] = rimPt(a);
      const dx = x - lx;
      const dz = z - lz;
      const d = Math.hypot(dx, dz);
      if (d < SPACING) {
        continue;
      }
      const ux = dx / d;
      const uz = dz / d;
      const mx = (x + lx) * 0.5;
      const mz = (z + lz) * 0.5;
      lx = x;
      lz = z;
      // BOTH ENDS ON GROUND, AND THE MIDDLE: a panel is a straight chord, so on a
      // tight inside bend its ends reach further out than its centre — and on an
      // outside bend its centre hangs where the ends do not (a second seed found it).
      const hx = ux * SPACING * 0.5;
      const hz = uz * SPACING * 0.5;
      if (!onDeck(mx - hx, mz - hz) || !onDeck(mx + hx, mz + hz) || !onDeck(mx, mz)) {
        continue;
      }
      if (!free(mx, mz, 1.2)) {
        continue;
      }
      fences.push({ x: mx, z: mz, yaw: Math.atan2(-uz, ux) });
    }
  }

  // The stream runs to the rim on the fall's bearing: `buildRock` paints its BED and
  // `buildStream` lays the water over it, so the plan carries a bearing, not a shape.
  const [fx, fz] = at(fallAngle, PLAZA * 0.9);
  // NOTHING STANDS OVER THE VOID: the outline is not a circle, and every ring above
  // is a fraction of the radius — one seed puts a bush, a tree or a lamp past the
  // rim on some bearing, where its collider would be drawn down to the ground.
  const grounded = <T extends { x: number; z: number }>(list: T[]): T[] =>
    list.filter((p) => onDeck(p.x, p.z));
  return {
    buildings: grounded(buildings),
    paths,
    streets,
    lamps: grounded(lamps),
    fences,
    trees: grounded(trees),
    rocks,
    plots,
    fallAngle,
    focus: { x: fx * 0.4, z: fz * 0.4 },
    mooring,
  };
}

/**
 * The island's outline, in cells, at a bearing. A SMALL envelope with a HIGH-VARIANCE
 * STAGGERED edge inside it (SPEC.md §1) — neither an amoeba nor a circle. Nothing ever
 * reaches 1.00 R: `CarrierBody`'s ride volume is `ISLAND_R` exactly, so an overshoot
 * puts walkable deck past where tools/test-carrier.mjs steps off.
 */
function outlineAt(theta: number, phase: number): number {
  // `theta` is `atan2(x, z)`, so 0 is +Z, i.e. compass SOUTH (SPEC.md §0); compass
  // bearing B is 180 - theta in degrees.
  let t = theta;
  while (t > Math.PI) {
    t -= Math.PI * 2;
  }
  while (t < -Math.PI) {
    t += Math.PI * 2;
  }
  // The southern chord: the map flattens to 0.92-0.95 R at compass 150-220. NOT
  // seeded — a phase term would roll it onto the gate or the fall, both pinned.
  const chord = 0.024 * Math.exp(-(((t + 0.09) / 0.62) ** 2));
  // ...with one shallow scallop inside it at compass 205. Both are HALF what they
  // were: the stagger below supplies most of the departure from a circle.
  const scallop = 0.018 * Math.exp(-(((t + 0.44) / 0.22) ** 2));
  // THE COASTLINE IS A STAGGER, NOT A WOBBLE (SPEC.md §1): one hashed offset per ~3
  // map-blocks of arc, from three levels. Harmonics small enough to keep the envelope
  // land under the one-cell quantisation and render as a clean ellipse.
  const sector = Math.floor(((t + Math.PI) / (Math.PI * 2)) * 54);
  const lev = hash2(sector, 0, 29);
  const stagger = lev < 0.34 ? 0 : lev < 0.67 ? -0.042 : -0.082;
  const r =
    0.96 -
    chord -
    scallop +
    stagger +
    // Three odd harmonics, seeded: the slow bend the staggers sit on. They sum to
    // 0.038, which with the mean of 0.960 pins the PEAK at 0.998.
    0.016 * Math.sin(3 * theta + phase * 1.7) +
    0.013 * Math.sin(7 * theta - phase) +
    0.009 * Math.sin(11 * theta + phase * 0.6);
  // Both clamps are contracts: 0.998 is the ride volume less a rounding, and 0.885 is
  // SPEC.md §1's "nothing cuts more than 0.10 R", measured off the PEAK.
  return RC * Math.max(0.885, Math.min(0.998, r));
}

/**
 * Where a column sits between centre and rim, 0..1, on a TWO-CELL LATTICE — the gauge
 * the keel's shelves are cut on, or terrace boundaries become one-cell notches and the
 * underside is a hairbrush. `buildRock` and `columnDepth` must both resolve here.
 */
function keelD01(gx: number, gz: number, phase: number): number {
  const bx = Math.floor(gx / 2) * 2 + 1;
  const bz = Math.floor(gz / 2) * 2 + 1;
  const d = Math.hypot(bx, bz);
  return Math.min(1, d / outlineAt(Math.atan2(bx * CELL, bz * CELL), phase));
}

function depthAt(d01: number, gx: number, gz: number): number {
  // A CONE THAT ACCELERATES INWARD, so the keel comes to a ROOT. The exponent sets the
  // WIDTH at a given depth, the INVERSE of the depth profile; 1.55 gives ~0.55 of the
  // deck width at half the drop. The MIDDLE is untouched, so `KEEL` never moves.
  const taper = TAPER * Math.pow(Math.max(0, 1 - d01), 1.55);
  // Roughened in WHOLE LEDGES before quantising, or the terracing is erased. Hashed
  // coarsely (11 cells), and not at the root, where a wobble flattens the point.
  const wob = Math.round((hash2(Math.floor(gx / 11), Math.floor(gz / 11), 11) - 0.5) * 2);
  // ...and it only CUTS on the outer skirt: past 0.55 a +1 wobble hands width back to
  // a cone that has already come in, which is the bucket silhouette.
  const wobble = d01 < 0.25 ? 0 : d01 > 0.55 ? Math.min(0, wob) : wob;
  const stepped = (Math.round(taper / LEDGE) + wobble) * LEDGE;
  return Math.max(2, CLIFF + Math.max(0, stepped));
}

interface SkyParts {
  readonly tower: Template;
  /** Six: three plans, each with a slate roof and a shingle one. */
  readonly cottages: readonly Template[];
  readonly well: Template;
  readonly stall: Template;
  readonly fence: Template;
  readonly lamp: Template;
  readonly gate: Template;
  readonly bushes: readonly Template[];
  readonly smoke: Template;
}

/**
 * A registry holding exactly one town, in the island's own coordinates. Handing `Npcs`
 * a LOCAL town centred on (0, 0) lets the whole NPC system be reused unchanged.
 */
function localRegistry(town: TownInfo): TownRegistry {
  return {
    all: [town],
    get: (id) => (id === town.id ? town : undefined),
    nearest: () => town,
    roads: [],
  };
}

/**
 * THE ISLAND'S OWN STREETS, as a path network in its LOCAL frame — issue #142 §1
 * replaced a stub that answered Infinity to everything. Local because the island moves
 * and a world network would be rebuilt every frame. `y` is 0: the plateau is flat.
 */
function streetNetwork(
  paths: ReadonlyArray<readonly [number, number, number, number]>,
): RoadNetwork {
  const net = new RoadNetwork();
  const profile = flagstoneProfile(PATH_HALF);
  paths.forEach(([x0, z0, x1, z1], i) => {
    const road: Road = {
      id: `street:sky-${i}`,
      fromId: "town:skyhaven",
      toId: "town:skyhaven",
      profile,
      pts: [
        { x: x0, z: z0, y: 0, bridge: false },
        { x: x1, z: z1, y: 0, bridge: false },
      ],
      trim: new Float32Array(8),
    };
    net.add(road);
  });
  net.build();
  return net;
}

const _dbg = { x: 0, z: 0 };

export class SkyIsland extends CarrierBody implements NpcFrame {
  /** The settlement's public face — name, colour, radius. Its x/z are LIVE. */
  readonly town: SkyTownInfo;
  readonly npcs: Npcs | null;

  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];
  private nightGlowMat: THREE.MeshStandardMaterial | null = null;
  /**
   * Where four real local lights would stand; emissive windows alone cannot
   * illuminate a wall. ANCHORS, not lights: the world owns one set of four and
   * hands it to the island nearest the camera (`holdNightLights`), because every
   * forward light is another lighting loop in every standard material's shader —
   * four islands with four each doubled the shader sweep at boot.
   */
  readonly nightLamps: Array<{ x: number; y: number; z: number; peak: number; distance: number }> = [];
  private heldLights: THREE.PointLight[] = [];
  private darkness = 0;
  /** The fall off the rim. Null when `water=0`. Disposes its own geometry, so not in `geos`. */
  private readonly fall: Waterfall | null = null;
  /** The water in the channel. Null when `water=0`. Geometry and material are ours; the
   * material's UNIFORM VALUES are the world's, shared by reference. */
  private stream: THREE.Mesh | null = null;
  private canalStones = 0;

  applyCelestial(state: Readonly<CelestialState>): void {
    this.fall?.applyCelestial(state);
    if (this.nightGlowMat) {
      this.nightGlowMat.emissiveIntensity = 1.65 * state.night * state.night;
    }
    this.darkness = state.night * state.night;
    this.lightHeldLamps();
  }

  private lightHeldLamps(): void {
    for (let i = 0; i < this.heldLights.length; i++) {
      const lamp = this.nightLamps[i];
      this.heldLights[i].intensity = lamp ? lamp.peak * this.darkness : 0;
    }
  }

  /** Take the world's shared night lights: parented here, at the anchors, at tonight's darkness. */
  holdNightLights(lights: THREE.PointLight[]): void {
    this.heldLights = lights;
    for (let i = 0; i < lights.length; i++) {
      const lamp = this.nightLamps[i];
      const light = lights[i];
      light.distance = lamp?.distance ?? 1;
      light.position.set(lamp?.x ?? 0, lamp?.y ?? 0, lamp?.z ?? 0);
      this.root.add(light);
    }
    this.lightHeldLamps();
  }

  releaseNightLights(): void {
    for (const light of this.heldLights) {
      this.root.remove(light);
    }
    this.heldLights = [];
  }
  /** The rock mesh, kept only so `debugFall` can report where `buildRock` put it. */
  private rock: THREE.Mesh | null = null;
  /** The lowest voxel `build` re-based the rock against. See `debugFall`. */
  private rockMinY = 0;
  private readonly solids = new StructureField();
  /** Where the island wants to be, world x/z. Re-picked on arrival. */
  private tx = 0;
  private tz = 0;
  private vx = 0;
  private vz = 0;
  private readonly rng: () => number;
  /** Where the plan put the wood, LOCAL x/z interleaved. For `debugTrees` only (issue #80). */
  private readonly treeSpots: number[] = [];
  /** The flagged streets, in the island's own frame. See `streetNetwork`. */
  private streets!: RoadNetwork;
  private pavedCells = 0;
  /** The outline's phase, so two seeds are two different islands. */
  private readonly phase: number;
  /** The balloon's berth, LOCAL: the deck is y = 0, and `this` is the frame. */
  readonly mooring: Mooring;

  constructor(
    private readonly terrain: Terrain,
    props: PropLib,
    data: SkyTownData,
    private readonly homeX: number,
    private readonly homeZ: number,
    seed: number,
    /** The world's water shader. Passed in so the stream cannot be clocked or lit
     * differently from the ground's; never disposed by the island. */
    waterMat: THREE.ShaderMaterial,
  ) {
    super(`carrier:town:${data.id}`, ISLAND_R);
    this.rng = mulberry32(seed ^ 0x51a7);
    this.phase = this.rng() * Math.PI * 2;
    this.x = homeX;
    this.z = homeZ;
    this.y = MIN_ALT;
    this.tx = homeX;
    this.tz = homeZ;

    this.town = {
      id: data.id,
      nameKey: data.nameKey,
      kind: "hamlet",
      x: homeX,
      y: MIN_ALT,
      z: homeZ,
      radius: data.radius,
      outerRadius: ISLAND_R,
      // The GATE of an air-only town is its middle: no road, no threshold. Kept because
      // `TownInfo` is the quest-facing contract and an objective must not ask the kind.
      gateX: homeX,
      gateZ: homeZ,
      gateAngle: 0,
      color: data.color,
      // No keep-out: a spawn rule is a disc on the GROUND, and nothing can spawn on the
      // deck anyway — every spawn path resolves its candidate against `getHeight`.
      noSpawnRadius: 0,
      carried: true,
    };

    // THE PLAN FIRST: the paths and the stream are painted INTO the rock.
    const parts: SkyParts = {
      tower: skyTower(),
      // Three plans by two roof materials; the layout picks `kind` or `kind + 3`.
      cottages: [
        skyCottage(0),
        skyCottage(1),
        skyCottage(2),
        skyCottage(0, true),
        skyCottage(1, true),
        skyCottage(2, true),
      ],
      well: skyWell(),
      stall: skyStall(),
      fence: skyFence(),
      lamp: skyLamp(),
      gate: skyGate(),
      bushes: [skyBush(false), skyBush(true)],
      smoke: skySmoke(),
    };
    const plan = planSkyhaven(
      seed,
      parts,
      props,
      // The deck's own answer, so the plan and the rock cannot disagree about ground.
      (x, z) => this.localDeck(x, z) > -Infinity,
      (a) => outlineAt(a, this.phase) * CELL,
    );
    this.streets = plan.streets;
    this.mooring = { ...plan.mooring, y: 0, frame: this };
    this.buildRock(plan);
    for (const t of plan.trees) {
      this.treeSpots.push(t.x, t.z);
    }
    this.canalStones = plan.rocks.length;

    // Under `flags.water`: turning water off means no water anywhere.
    if (flags.water) {
      this.buildStream(plan, waterMat);
      const a = this.fallAnchor(plan);
      this.fall = new Waterfall({
        ...a,
        bearing: plan.fallAngle,
        // Forty courses, in world units: it ends inside the keel and dissolves there
        // rather than stopping square (SPEC §6).
        length: 40 * CELL,
        // The same constant `onStream` flares its mouth to, so both are one width.
        lipWidth: FALL_LIP,
        // A light steady drift — prevailing wind, not the island's passage (see `update`).
        lateralPush: 2.2,
        swayFromCarrier: true,
      });
      this.root.add(this.fall.group);
    }

    const stamp = new SolidStamp(this.solids);
    const layout = content.factory<CarriedLayout>(CARRIED_LAYOUT_KIND, data.layout);
    layout?.(stamp, parts, plan);
    this.solids.build();
    this.emit(stamp.acc, props.solidMat, true, false);

    const night = new Accum();
    for (const b of plan.buildings) {
      if (!b.light) {
        continue;
      }
      const [front, height] = b.light;
      night.add(
        SKY_WINDOW,
        b.x + Math.sin(b.yaw) * front,
        height,
        b.z + Math.cos(b.yaw) * front,
        b.yaw,
        1,
        1,
        1,
        1,
      );
    }
    for (const lamp of plan.lamps) {
      // skyLamp's flame is course 8 at SV=0.6: 4.8 units above the deck.
      night.add(SKY_LANTERN, lamp.x, 4.8, lamp.z, lamp.yaw, 1, 1, 1, 1);
    }
    this.nightGlowMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.5,
      metalness: 0,
      emissive: new THREE.Color(0xffa83d),
      emissiveIntensity: 0,
    });
    this.nightGlowMat.userData.bsNightRole = "skyhaven-lights";
    this.emit(night, this.nightGlowMat, false, true);

    // Emissive voxels identify the fixtures but Three has no GI, so four shadowless,
    // range-limited lights supply the direct light. Not one per lantern, and not
    // one set per island — see `nightLamps`.
    this.nightLamps.push({ x: 0, y: 9, z: 0, peak: 26, distance: 48 });
    for (let k = 0; k < Math.min(3, plan.lamps.length); k++) {
      const lamp = plan.lamps[Math.floor((k * plan.lamps.length) / 3)];
      this.nightLamps.push({ x: lamp.x, y: 5.2, z: lamp.z, peak: 18, distance: 36 });
    }

    // Every query in the site is in the island's frame, and `this` is the frame. `Npcs`
    // transforms to world once a slice, so main.ts's talk test needs no branch.
    const site: NpcSite = {
      towns: localRegistry({ ...this.town, x: 0, z: 0, gateX: 0, gateZ: 0 }),
      roads: this.streets,
      getHeight: () => 0,
      structureTopAt: (x, z) => this.solids.topAt(x, z),
      focusOf: () => plan.focus,
    };
    const crew = new Npcs(site, this);
    this.npcs = crew.all.length > 0 ? crew : null;
    if (this.npcs) {
      this.root.add(crew.group);
    } else {
      crew.dispose();
    }
  }

  /**
   * THE WALKING SURFACE, local — a CONSTANT, because the plateau is one flat course of
   * turf: a voxel deck steps 1.2 and `MAX_STEP_UP` is 0.5. -Infinity past the rim,
   * which is what makes walking off one a fall.
   */
  localDeck(lx: number, lz: number): number {
    // ASKED OF THE CELL, NOT THE POINT, so the rim you fall off is the rim you see —
    // this and `buildRock` resolve the same cell centre through the same `outlineAt`.
    const gx = Math.floor(lx / CELL);
    const gz = Math.floor(lz / CELL);
    const wx = (gx + 0.5) * CELL;
    const wz = (gz + 0.5) * CELL;
    const d = Math.hypot(gx + 0.5, gz + 0.5);
    return d <= outlineAt(Math.atan2(wx, wz), this.phase) ? 0 : -Infinity;
  }

  /** Top of everything a body can stand on, local: the deck and what was built on it.
   * Taken once here so a rider asks one question — see `CarrierRide.support`. */
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
    // The residents block too, and are a SECOND field because a `StructureField` is
    // frozen by `build()` before the crew standing in the town is placed.
    const who = this.npcs?.solids.topAt(lx, lz) ?? -Infinity;
    return who > top ? who : top;
  }

  /**
   * THE KEEL, local: the bottom face of the deepest cube, +Infinity past the rim.
   * Measured off `columnDepth` so what a flyer hits is what they see. A cube at `-k`
   * spans [-k * CELL, (-k + 1) * CELL]; `columnDepth` reports 0 for a LIP column.
   */
  localBottom(lx: number, lz: number): number {
    if (this.localDeck(lx, lz) === -Infinity) {
      return Infinity;
    }
    const depth = this.columnDepth(Math.floor(lx / CELL), Math.floor(lz / CELL));
    return -(depth > 0 ? depth : LIP_COURSES) * CELL;
  }

  // `toWorld`, `y` and `yaw` come from CarrierBody; the interface exists so
  // world/npc.ts can transform its records without importing a carrier.

  protected steer(dt: number): void {
    // A staged capture holds it still: two runs must produce the same pictures.
    if (flags.photo) {
      return;
    }
    const dx = this.tx - this.x;
    const dz = this.tz - this.z;
    if (dx * dx + dz * dz < ARRIVE * ARRIVE) {
      this.pickDestination();
    }

    const len = Math.max(1e-4, Math.hypot(dx, dz));
    const wantVX = (dx / len) * CRUISE;
    const wantVZ = (dz / len) * CRUISE;
    // Exponential approach, frame-rate independent; ~5 s to settle onto a heading.
    const k = 1 - Math.exp(-TURN_LAMBDA * dt);
    this.vx += (wantVX - this.vx) * k;
    this.vz += (wantVZ - this.vz) * k;
    this.x += this.vx * dt;
    this.z += this.vz * dt;

    // Rate-limited rather than damped: a passenger feels this through `dyaw`, and an
    // exponential spends most of the turn in the first half-second.
    const travel = Math.atan2(this.vx, this.vz);
    let turn = travel - this.yaw;
    while (turn > Math.PI) {
      turn -= Math.PI * 2;
    }
    while (turn < -Math.PI) {
      turn += Math.PI * 2;
    }
    const step = YAW_RATE * dt;
    this.yaw += Math.max(-step, Math.min(step, turn));

    // THE MOUNTAIN RULE, not avoidance: hold the keel over the worst ground it is about
    // to be above, so no approach angle can put it into a peak.
    const want = Math.min(MAX_ALT, Math.max(MIN_ALT, this.groundBelow() + KEEL + KEEL_MARGIN));
    const rise = CLIMB_RATE * dt;
    this.y += Math.max(-rise, Math.min(rise, want - this.y));
    this.town.x = this.x;
    this.town.y = this.y;
    this.town.z = this.z;
    this.town.gateX = this.x;
    this.town.gateZ = this.z;
  }

  /** Highest ground under the footprint and along the heading. The ring is at 0.72 R
   * because the keel tapers — the root hits a peak first, not the skirt. */
  private groundBelow(): number {
    let top = this.terrain.getHeight(this.x, this.z);
    const ring = ISLAND_R * 0.72;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const h = this.terrain.getHeight(this.x + Math.sin(a) * ring, this.z + Math.cos(a) * ring);
      if (h > top) {
        top = h;
      }
    }
    // Ahead along TRAVEL, not the hull's facing: travel decides what it arrives over.
    const len = Math.max(1e-4, Math.hypot(this.vx, this.vz));
    const fx = this.vx / len;
    const fz = this.vz / len;
    for (let k = 1; k <= 4; k++) {
      const d = ISLAND_R * (1 + (LOOK_AHEAD - 1) * (k / 4));
      const h = this.terrain.getHeight(this.x + fx * d, this.z + fz * d);
      if (h > top) {
        top = h;
      }
    }
    return Math.max(top, WATER_LEVEL);
  }

  private pickDestination(): void {
    for (let attempt = 0; attempt < 8; attempt++) {
      const a = this.rng() * Math.PI * 2;
      // sqrt of the roll, so the points are uniform over the AREA.
      const d = Math.sqrt(this.rng()) * ROAM_R;
      const x = this.homeX + Math.sin(a) * d;
      const z = this.homeZ + Math.cos(a) * d;
      if ((x - this.x) ** 2 + (z - this.z) ** 2 < (ROAM_R * 0.34) ** 2) {
        continue;
      }
      this.tx = x;
      this.tz = z;
      return;
    }
    this.tx = this.homeX;
    this.tz = this.homeZ;
  }

  /** Pose the residents. The island's own motion is in `advance`, which the carrier
   * registry runs at the top of the slice rather than at the end. */
  update(dt: number, time: number, focus: THREE.Vector3): void {
    this.npcs?.update(dt, time, focus);
    if (this.fall) {
      // The fall trails behind: `advance` published this slice's step in WORLD x/z, so
      // rotate it into the island's frame — no translation, a delta has no origin.
      const lx = this.dx * this.cy - this.dz * this.sy;
      const lz = this.dx * this.sy + this.dz * this.cy;
      this.fall.update(dt, lx, lz);
    }
  }

  setVisible(v: boolean): void {
    this.root.visible = v;
  }

  /** Show or hide the island's water — the fall AND the stream, or the layer lies: a
   * hidden plume over a running channel pours into a lip with nothing coming off it. */
  setWaterfallVisible(v: boolean): void {
    this.fall?.setVisible(v);
    if (this.stream) {
      this.stream.visible = v;
    }
  }

  /** Link the fall's two shader programs at boot. See `warmUpSteps` in main.ts. */
  warmUpWaterfall(render: () => void): void {
    this.fall?.warmUp(render);
  }

  /**
   * The fall's counters, plus the rebase identity `buildRock` documents: `meshOriginY`
   * must equal `meshMinY * CELL`, and `meshMinY` must still be the KEEL's depth.
   */
  debugFall(): Record<string, number> {
    return {
      meshOriginY: +(this.rock?.position.y ?? NaN).toFixed(5),
      meshMinY: this.rockMinY,
      cell: CELL,
      hasFall: this.fall ? 1 : 0,
      // The channel's own surface as a triangle count. See `buildStream`.
      streamTris: this.stream ? (this.stream.geometry.getIndex()?.count ?? 0) / 3 : 0,
      canalStones: this.canalStones,
      ...this.fall?.stats(),
    };
  }

  /**
   * Append this island's solid boxes to `out`, IN WORLD SPACE, in the same
   * `[cx, cz, hx, hz, yaw, topY]` layout `StructureField.debugBoxes` uses. The
   * transform is the point: raw boxes would be drawn nowhere near the island.
   */
  debugStructures(out: number[]): void {
    const local: number[] = [];
    this.solids.debugBoxes(local);
    this.npcs?.solids.debugBoxes(local);
    for (let i = 0; i < local.length; i += 6) {
      this.toWorld(local[i], local[i + 1], _dbg);
      out.push(
        _dbg.x,
        _dbg.z,
        local[i + 2],
        local[i + 3],
        // A local bearing `a` comes out as `a + yaw`, as in `StructureField.add`.
        local[i + 4] + this.yaw,
        local[i + 5] + this.y,
      );
    }
  }

  /** The flagged streets and what stands near them, local. See `World.debugCarriedStreets`. */
  debugStreets(): { count: number; paved: number; clear: number[] } {
    const clear: number[] = [];
    for (let i = 0; i < this.treeSpots.length; i += 2) {
      // Capped rather than Infinity: this crosses to a probe as JSON, where Infinity
      // becomes `null` and every assertion against it reads as vacuously true.
      const d = this.streets.edgeDistanceTo(this.treeSpots[i], this.treeSpots[i + 1]);
      clear.push(Number.isFinite(d) ? +d.toFixed(3) : 999);
    }
    clear.sort((a, b) => a - b);
    return { count: this.streets.roads.length, paved: this.pavedCells, clear };
  }

  /** The wood, in world space as of now. See `World.debugCarriedTrees`. */
  debugTrees(): Array<{ x: number; z: number }> {
    const out: Array<{ x: number; z: number }> = [];
    for (let i = 0; i < this.treeSpots.length; i += 2) {
      this.toWorld(this.treeSpots[i], this.treeSpots[i + 1], _dbg);
      out.push({ x: _dbg.x, z: _dbg.z });
    }
    return out;
  }

  dispose(): void {
    this.npcs?.dispose();
    this.fall?.dispose();
    for (const g of this.geos) {
      g.dispose();
    }
    for (const m of this.mats) {
      m.dispose();
    }
    this.geos.length = 0;
    this.mats.length = 0;
  }

  /**
   * One accumulator -> one mesh under the island's root. `owned` says whether the
   * MATERIAL is ours to dispose — the town's timber is `PropLib.solidMat`.
   */
  private emit(acc: Accum, mat: THREE.Material, shadows: boolean, owned: boolean): void {
    const geo = acc.toGeometry();
    if (!geo) {
      if (owned) {
        mat.dispose();
      }
      return;
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    mesh.matrixAutoUpdate = false;
    this.root.add(mesh);
    this.geos.push(geo);
    if (owned) {
      this.mats.push(mat);
    }
  }

  /**
   * THE ROCK, as cubes, SHELL ONLY: a filled island is 300k voxels, the surface ~30k
   * (the rule is in `paintColumn`). Never a static shadow caster — it moves.
   */
  /**
   * The rim column the fall leaves from, local. ON the outline: started inboard, the
   * sheet's head tucks under the rim. Local y is 0, which is what `localDeck` answers.
   */
  private fallAnchor(plan: SkyPlan): { x: number; y: number; z: number } {
    const rimD = outlineAt(plan.fallAngle, this.phase);
    const gx0 = Math.round(Math.sin(plan.fallAngle) * rimD);
    const gz0 = Math.round(Math.cos(plan.fallAngle) * rimD);
    // Cell CENTRES, matching how `buildRock` converts a cell to a world column.
    return { x: (gx0 + 0.5) * CELL, y: 0, z: (gz0 + 0.5) * CELL };
  }

  private buildRock(plan: SkyPlan): void {
    const v = new VoxelModel();
    const R = Math.ceil(RC) + 2;

    /** Is this cell inside a flagged street? Asked of the path network (issue #142), so
     * what is drawn and what a tree is kept out of cannot drift. Zero is the rim. */
    const onPath = (wx: number, wz: number): boolean => this.streets.edgeDistanceTo(wx, wz) < 0;

    /** THE SQUARE IS PAVED, not worn: everything inside `PLAZA` is flagstone. */
    const onPlaza = (wx: number, wz: number): boolean => wx * wx + wz * wz < PLAZA * PLAZA;

    /** Flagstone, and counted so a probe can say the fold-in moved no cell. */
    const paved = (wx: number, wz: number): boolean => {
      if (!onPlaza(wx, wz) && !onPath(wx, wz)) {
        return false;
      }
      this.pavedCells++;
      return true;
    };

    const onPlot = (wx: number, wz: number): boolean =>
      plan.plots.some((g) => (wx - g.x) ** 2 + (wz - g.z) ** 2 < g.r * g.r);

    for (let gx = -R; gx <= R; gx++) {
      for (let gz = -R; gz <= R; gz++) {
        const wx = (gx + 0.5) * CELL;
        const wz = (gz + 0.5) * CELL;
        const d = Math.hypot(gx + 0.5, gz + 0.5);
        const edge = outlineAt(Math.atan2(wx, wz), this.phase);
        if (d > edge) {
          continue;
        }
        const depth = depthAt(keelD01(gx, gz, this.phase), gx, gz);
        // THE LIP: turf reaches the outline, stone stops a course short, so the grass
        // overhangs and prints a shadow line. `lipAt` makes the setback ragged.
        const stone = d <= edge - lipAt(gx, gz);
        // THE GREY RIM-STONE COLLAR, ragged inside as `lipAt` is outside. A SALT OF ITS
        // OWN: sharing `lipAt`'s would correlate the two edges into one big notch.
        const rim =
          d > edge - RIM_STONE - (hash2(Math.floor(gx / 2), Math.floor(gz / 2), 89) < 0.35 ? 1 : 0);
        paintShellColumn(
          v,
          gx,
          gz,
          depth,
          stone,
          // The bed first: the collar reads 0 at the outflow, cut by the stream.
          onStream(plan.fallAngle, wx, wz)
            ? "streambed"
            : rim
              ? "rimstone"
              : paved(wx, wz)
                ? "paved"
                : onPlot(wx, wz)
                  ? "tilled"
                  : "turf",
          CLIFF + TAPER,
          this.columnDepthFn,
        );
      }
    }

    // THE WATERFALL IS NOT HERE ANY MORE (world/waterfall.ts). What is painted above is
    // the stream's BED; the water is `buildStream`'s surface.

    const mesh = v.build(CELL, false);
    // `build` re-bases the model so its lowest voxel sits at y = 0; adding `minY` back
    // puts a cell at `gy` at `gy * CELL` for ANY `minY`, so the two cancel exactly.
    // tools/test-waterfall.mjs asserts both halves.
    mesh.position.y = v.bounds(false).minY * CELL;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.name = "sky:rock";
    this.rock = mesh;
    this.rockMinY = v.bounds(false).minY;
    this.root.add(mesh);
    this.geos.push(mesh.geometry);
    this.mats.push(mesh.material as THREE.Material);
  }

  /**
   * THE WATER IN THE CHANNEL — the world's own water surface, laid over the bed
   * `buildRock` painted. Issue #89. The material is the LAKES', handed in from
   * `createWorld`, so it shares their clock, sun uniforms and shader program.
   *
   * This file supplies the ATTRIBUTES, since `buildWaterMesh` bakes them off a terrain
   * height field and there is none here: `aDepth` falls to 0 at the bank so the
   * waterline dissolves, `aShore` is CELLS for the foam band, `aLand` is 0. PER-CORNER,
   * not per-cell: the channel is three cells across, so a per-cell ramp is a staircase.
   */
  private buildStream(plan: SkyPlan, mat: THREE.ShaderMaterial): void {
    const R = Math.ceil(RC) + 2;
    const pos: number[] = [];
    const nor: number[] = [];
    const dep: number[] = [];
    const sho: number[] = [];
    const lnd: number[] = [];
    const idx: number[] = [];
    /** Depth and shore distance at a GRID CORNER, i.e. the cube's own corner. */
    const corner = (gx: number, gz: number): void => {
      const wx = gx * CELL;
      const wz = gz * CELL;
      const s = streamAt(plan.fallAngle, wx, wz);
      // Outside the water: depth 0 (transparent) and shore 0 (full foam).
      const t = s ? Math.max(0, 1 - s.across / s.halfW) : 0;
      pos.push(wx, STREAM_LIFT, wz);
      nor.push(0, 1, 0);
      // Smoothstepped: the linear ramp put a crease down each bank.
      dep.push(STREAM_DEPTH * t * t * (3 - 2 * t));
      // `aShore` is in the shader's own cells and its foam reaches ~1.65 of them, so a
      // TERRAIN distance floods a three-cell channel. `FOAM_REACH` is how far the band
      // may come in, in world units, scaled into the shader's numbers.
      const FOAM_REACH = 0.55;
      const bank = s ? Math.max(0, s.halfW - s.across) : 0;
      sho.push(Math.min(5, (bank / FOAM_REACH) * 1.65));
      lnd.push(0);
    };
    for (let gx = -R; gx <= R; gx++) {
      for (let gz = -R; gz <= R; gz++) {
        // The SAME two tests `buildRock` paints the bed with, off the same cell centre.
        const wx = (gx + 0.5) * CELL;
        const wz = (gz + 0.5) * CELL;
        if (Math.hypot(gx + 0.5, gz + 0.5) > outlineAt(Math.atan2(wx, wz), this.phase)) {
          continue;
        }
        if (!onStream(plan.fallAngle, wx, wz)) {
          continue;
        }
        const base = pos.length / 3;
        corner(gx, gz);
        corner(gx + 1, gz);
        corner(gx, gz + 1);
        corner(gx + 1, gz + 1);
        idx.push(base, base + 2, base + 3, base, base + 3, base + 1);
      }
    }
    if (idx.length === 0) {
      return;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute("aDepth", new THREE.Float32BufferAttribute(dep, 1));
    geo.setAttribute("aShore", new THREE.Float32BufferAttribute(sho, 1));
    geo.setAttribute("aLand", new THREE.Float32BufferAttribute(lnd, 1));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    // The world's water minus the chunk-streaming dissolve, which has no far sheet here.
    const own = createCarriedWaterMaterial(mat);
    const mesh = new THREE.Mesh(geo, own);
    // The lake's own render order, so both sort the same against transparent VFX.
    mesh.renderOrder = 2;
    // `depthWrite` is off here: a casting film would be a shadow with nothing under it.
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.name = "sky:stream";
    this.stream = mesh;
    this.root.add(mesh);
    this.geos.push(geo);
    // Ours to dispose. The UNIFORM VALUES inside are the world's and are untouched.
    this.mats.push(own);
  }

  /** One column: turf (or flagstone, or streambed), dirt, then stone to `depth` — only
   * cells whose faces show. `stone` is false on the rim ring, so the turf overhangs. */
  /** `columnDepth`, bound once: the painter asks it for four neighbours per column. */
  private readonly columnDepthFn = (gx: number, gz: number): number => this.columnDepth(gx, gz);

  /** `depthAt` for a neighbour, or 0 where the neighbour is off the island. */
  private columnDepth(gx: number, gz: number): number {
    const wx = (gx + 0.5) * CELL;
    const wz = (gz + 0.5) * CELL;
    const d = Math.hypot(gx + 0.5, gz + 0.5);
    const edge = outlineAt(Math.atan2(wx, wz), this.phase);
    if (d > edge - lipAt(gx, gz)) {
      return 0;
    }
    return depthAt(keelD01(gx, gz, this.phase), gx, gz);
  }
}

/**
 * What a CARRIED town's layout is handed: a stamp that draws and blocks, the parts bin,
 * and the plan. EVERY COORDINATE IS LOCAL. It gets a plan rather than a road network
 * and a height field, because the plan had to exist before the ground did.
 */
export type CarriedLayout = (solid: SolidStamp, parts: SkyParts, plan: SkyPlan) => void;

/**
 * Skyhaven: a tower on a square, cottages facing it, trees at the rim, a rail that
 * marks the edge without closing it. Where is `planSkyhaven`; this is only stamping.
 */
const buildSkyhaven: CarriedLayout = (solid, parts, plan) => {
  for (const b of plan.buildings) {
    solid.add(b.t, b.x, 0, b.z, b.yaw, b.s ?? 1);
  }
  for (const f of plan.fences) {
    solid.add(parts.fence, f.x, 0, f.z, f.yaw);
  }
  for (const l of plan.lamps) {
    solid.add(parts.lamp, l.x, 0, l.z, l.yaw);
  }
  // The trees go through the same stamp, which blocks them: a template carries the
  // `trunk` its bake measured and `StructureField.add` makes a bole (issue #80).
  for (const t of plan.trees) {
    solid.add(t.t, t.x, 0, t.z, t.yaw, t.s);
  }
  // The canal stones block like every other boulder: what you stand next to stops you
  // sliding into the current where the rail is deliberately missing.
  for (const r of plan.rocks) {
    solid.add(r.t, r.x, 0, r.z, r.yaw, r.s);
  }
};

/**
 * The carried layouts this build implements. See `TownData.carried`. `gallery` and
 * `orrery` are PLACEHOLDERS: Skyhaven's stamping under another name, so Act 3's
 * towns exist, sit their crews and moor a balloon while their own kits are built
 * (issue #262 — lamp galleries, an observatory full of brass).
 */
const CARRIED_LAYOUTS: Readonly<Record<string, CarriedLayout>> = {
  skyhaven: buildSkyhaven,
  gallery: buildSkyhaven,
  orrery: buildSkyhaven,
};

for (const [name, fn] of Object.entries(CARRIED_LAYOUTS)) {
  defineFactory(CARRIED_LAYOUT_KIND, name, fn);
}

/** `TownInfo` with the fields a moving town rewrites every slice. */
type SkyTownInfo = {
  -readonly [K in keyof TownInfo]: TownInfo[K];
};

interface SkyTownData {
  id: string;
  nameKey: TownInfo["nameKey"];
  layout: string;
  radius: number;
  color: number;
}

/** Every carried settlement in this content, in load order — the first is the hub the debug hooks single out. */
export function readCarriedTowns(): SkyTownData[] {
  const found: SkyTownData[] = [];
  for (const asset of content.all<TownData>("town")) {
    if (!asset.data.carried) {
      continue;
    }
    const nameKey = displayKey(asset);
    if (nameKey === null) {
      continue;
    }
    found.push({
      id: asset.id.slice(asset.type.length + 1),
      nameKey,
      layout: asset.data.layout,
      radius: asset.data.radius,
      color: asset.data.color,
    });
  }
  return found;
}
