/**
 * SKYHAVEN — the town that flies. Issue #68.
 *
 * A single landmass drifting over the overworld with a settlement on its back,
 * and the first implementation of `CarrierInfo` (core/types.ts). Everything
 * generic about "a piece of the world that moves and carries what stands on it"
 * is in world/carriers.ts and NOT here: a boat, a lift and a monster big enough
 * to climb would reuse all of it and write only what this file writes — a
 * shape, a surface, and a rule for where it goes next.
 *
 * IT IS BUILT OUT OF CUBES, and the first version was not. It shipped as a
 * radial mesh — a smooth dome over a smooth keel — on the reasoning that a
 * voxel island at the town's own 0.28 scale would be 385 cells across and cost
 * 148k columns. That reasoning was right about the scale and wrong about the
 * conclusion: the answer is a COARSER cell, not a smooth surface. Everything
 * else in this game is cubes, the reference art for this island is emphatically
 * cubes, and a smooth landmass in the middle of it reads as an object from
 * another game. At `CELL` = 1.2 the island is 90 cells across, its cliffs
 * terrace the way the reference's do, and only the SHELL is painted (see
 * `paintColumn`), which is ~30k voxels — a hut is 2k.
 *
 * THE TOP IS FLAT, and that is a gameplay decision as much as a visual one. A
 * voxel deck steps in whole cells and `MAX_STEP_UP` is 0.5, so any terracing on
 * the plateau is a wall the player has to jump; the reference's raised tower
 * mound would be exactly that. So the plateau is one level, every building
 * stands on it, and the only vertical drama is the cliff you can walk off.
 *
 * WHAT IS AND IS NOT IN THIS FILE, since the island is three things at once:
 *
 *   the ROCK      a `VoxelModel` heightfield: flat grass plateau, an
 *                 overhanging turf lip, sheer cliff, then a terraced keel
 *                 tapering to a point, with vines down the face.
 *   the DECK      `deckAt`, which is a CONSTANT — and that is the point. The
 *                 mesh's top course and the step test read the same number, so
 *                 what you see is what you stand on by construction rather
 *                 than because two formulas currently agree.
 *   the TOWN      built from [world/sky-parts.ts](src/world/sky-parts.ts) — a
 *                 second parts bin, because plastered timber-framed walls under
 *                 blue slate are not the Encampment's canvas and thatch
 *                 recoloured.
 *
 * IT DOES NOT FLY INTO MOUNTAINS, and the mechanism is a floor rather than an
 * avoidance behaviour. `steer` samples the height field under the island's own
 * footprint AND along its heading, and holds its keel a fixed margin over the
 * worst of them; the horizontal wander is then free to go wherever it likes
 * because there is nowhere it can go that the altitude rule does not already
 * cover. A steering behaviour that turned away from peaks would have to be
 * right every time to avoid the one case that matters, where this is right by
 * not being able to be wrong.
 */
import * as THREE from 'three';
import type { TownInfo, TownRegistry } from '../core/types';
import { CarrierBody } from './carriers';
import { Accum, PropLib, type Template } from './props';
import { SolidStamp, StructureField } from './structures';
import { Npcs, type NpcFrame, type NpcSite } from './npc';
import type { RoadClearance } from './roads';
import { VoxelModel } from '../core/voxel';
import { mulberry32 } from './noise';
import { flags } from '../core/flags';
import {
  skyBush, skyCottage, skyFence, skyGate, skyLamp, skySmoke, skyStall, skyTower, skyWell,
} from './sky-parts';
import { CARRIED_LAYOUT_KIND, content, defineFactory, type TownData } from '../content';
import { displayKey, reportContentIssue } from '../core/content-bridge';
import type { Terrain } from './terrain';
import { WATER_LEVEL } from './terrain';

// ---------------------------------------------------------------------------
// Size
// ---------------------------------------------------------------------------

/**
 * World units per terrain voxel.
 *
 * THE ONE NUMBER THE WHOLE LOOK RESTS ON. It is twice the settlement's own
 * voxel gauge (`SV` = 0.6 in sky-parts.ts), so a cottage wall is two courses to
 * a cliff's one, which is the proportion the reference art has between its
 * buildings and its rock. Coarser and the cliff loses its terracing into a few
 * huge steps; finer and the chunkiness that makes it read as this game's world
 * goes away while the column count grows as the square.
 */
const CELL = 1.2;

/**
 * How many of OUR cells make one block of the authored plan.
 *
 * THE PLAN IS DRAWN AT A COARSER GAUGE THAN THE WORLD IS BUILT AT. The top-down
 * map this island is laid out from is 52 blocks across, and one of its blocks is
 * three of our cells: a map block is a stride of ground you could stand a barrel
 * on, and a cell is the resolution the cliff terraces and the coastline are
 * quantised to. Keeping the two apart is what lets the LAYOUT be authored in
 * whole readable blocks while the ROCK keeps a finer silhouette.
 */
const MAP_BLOCK = 3;

/**
 * The island's radius in MAP BLOCKS. 26 makes it 52 across, which is the plan.
 *
 * THIS IS WHERE THE ISLAND GOT BIG, and it is a correction to a reading rather
 * than a change of mind. It was 53.7 units of radius, "8 times the AREA of the
 * Encampment", which made a landmass you could see whole from the ground and
 * was far too small for the town the plan puts on it: at that size a dozen
 * cottages and a tower already filled it, and every critique of the early
 * passes came back to density and to empty lawn. One block of the authored plan
 * is three of our cells, so 26 blocks of radius is 187 units across, which is
 * room for the manor, the dwellings, a pond, an avenue and a tree belt with
 * space left between them.
 */
const MAP_R = 26;

/**
 * The island's footprint radius, in world units. Derived from the plan's own
 * gauge, so moving `MAP_R` or `MAP_BLOCK` moves everything with it.
 */
export const ISLAND_R = MAP_R * MAP_BLOCK * CELL;

/** The island's radius in CELLS, which is what every generator below works in. */
const RC = ISLAND_R / CELL;

/**
 * How many courses of SHEER cliff hang under the turf before the keel starts
 * tapering in.
 *
 * The reference's silhouette is a vertical band of stone under the grass and
 * THEN an inverted pyramid; without the band the island is a lens and reads as
 * a lily pad. 6 courses is 7.2 units — about twice a cottage wall, which is
 * roughly what the art shows.
 */
const CLIFF = 12;

/**
 * How much deeper the keel goes at the middle, in courses, under the cliff.
 *
 * THE FIRST PASS SHIPPED 16 AND IT WAS A PANCAKE. 23 courses of rock under a
 * 90-cell plateau is a quarter as deep as the island is wide, and captured from
 * the side (`shots/sky/2-side.png`, first pass) it read as a lily pad with a
 * village on it — the reference's profile is a landmass, roughly two thirds as
 * deep as it is across, and the depth is most of what makes it feel like
 * something that was torn out of the ground rather than a platter.
 *
 * 34 more courses puts the deepest point 40 courses — 48 units — below the
 * turf, against a 107-unit width. It is also the number `KEEL_MARGIN` has to
 * clear the mountains by, and `KEEL` below is the world-unit form of the same
 * fact, so raising it raises the island with it.
 */
const TAPER = 62;

/** The keel's depth at its deepest, in world units. Derived, never authored. */
const KEEL = (CLIFF + TAPER) * CELL;

/** Published so the cloud deck knows how far under the deck to pass. */
export const ISLAND_KEEL = KEEL;

/**
 * How coarsely the taper is QUANTISED, in courses.
 *
 * The single most reference-like thing in the generator. A continuous taper is
 * a cone with a staircase texture; rounding it to steps of 4 gives the keel
 * distinct LEDGES that run all the way round, which is what the art's underside
 * is made of — ten of them over the drop, which is what the art shows.
 *
 * The FIRST PASS quantised at 3 and then buried the result under two scales of
 * per-cell noise, and the ledges never appeared: captured from below it was a
 * flat-bottomed hairbrush (`shots/sky/5-underside.png`, first pass). The lesson
 * is that the noise has to be applied at the LEDGE's own granularity — whole
 * shelves wandering by whole steps — or it simply erases the terracing it was
 * meant to roughen.
 */
const LEDGE = 5;

/**
 * How far the turf overhangs the stone beneath it, in cells.
 *
 * One course, everywhere. It is a tiny thing that does an enormous amount of
 * work: it puts a hard shadow line under the grass all the way round the
 * island, which is what separates the green top from the grey cliff in every
 * one of the reference's six views. Without it the two read as one mass.
 */
const LIP = 1;

// ---------------------------------------------------------------------------
// Flight
// ---------------------------------------------------------------------------

/**
 * How far from home the island wanders, in world units.
 *
 * "Flying around random within a large radius of the spawn location of the
 * town", and 240 is what makes that a journey rather than a lap: the island is
 * somewhere different every time the player looks up, and never so far that it
 * has left the part of the map the rest of the game is in.
 */
const ROAM_R = 260;
/**
 * Cruise speed, world units/second.
 *
 * 1.0, down from the 2.4 this shipped with, which read as fast — and it read
 * that way for a reason worth writing down: the thing you judge the speed
 * against is the GROUND EIGHTY UNITS BELOW, and at that distance a landmass
 * this size sliding at walking pace looks like it is being flown rather than
 * drifting. A town is not a vehicle. At 1.0 it crosses its own diameter in
 * under two minutes, which is still plainly moving when you stand at the rim
 * and watch the meadow go by, and no longer looks propelled.
 *
 * Still far slower than the hero walks (6) and than a galebird flies (12.4), so
 * it can always be caught. That is the constraint the number cannot cross.
 */
const CRUISE = 1.0;
/** How hard it accelerates onto a new heading; the lambda of an exponential. */
const TURN_LAMBDA = 0.22;
/** How fast the hull's own heading follows its travel, radians/second. */
const YAW_RATE = 0.03;
/** A new destination is picked within this of the old one being reached. */
const ARRIVE = 26;

/**
 * How far the KEEL clears the highest ground under the island, in world units.
 *
 * This is the "don't fly into mountains" number and it is deliberately large:
 * the sample set below is finite, so the margin has to cover whatever a spire
 * between two samples can be. 14 units is about three of the height field's own
 * integer terraces, and the climb is rate-limited so the island rides up a
 * ridge rather than snapping over it.
 */
const KEEL_MARGIN = 14;
/** Never lower than this above sea level, whatever the ground below says. */
const MIN_ALT = 112;
/** ...and never higher, so it stays under the cumulus deck's own 80-142 band. */
const MAX_ALT = 138;
/** How fast it may climb or sink, world units/second. */
const CLIMB_RATE = 1.6;

/**
 * How far AHEAD of itself the island looks, as a multiple of its own radius.
 *
 * At `CRUISE` and `CLIMB_RATE` the island needs 8.8 seconds to gain the 14
 * units of a full margin, in which it travels 9. Looking one radius ahead of
 * its own rim gives it 54 — six times what the worst case needs, which is the
 * right size of margin for a number sampled at a dozen points.
 */
const LOOK_AHEAD = 2;

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------
// Read off the reference art rather than invented. The grass is a bright
// saturated green (it is the brightest thing in the picture after the sky), the
// stone is cool and desaturated, and the dirt band between them is narrow and
// warm — three families, and the contrast between them is what gives the rim
// its layered read.

// THE GREEN IS WARM AND NOT VERY SATURATED, which is the correction that made
// the biggest single difference. The first pass used a cold kelly green
// (0x7cc24c) and it read as plastic against the reference's olive turf; the art
// is a yellow-leaning green with dirt showing through it.
const GRASS = 0x7ea83c;
const GRASS_D = 0x668a30;
const GRASS_L = 0x93bd4c;
const DIRT = 0x6b5334;
const DIRT_D = 0x54401f;
// STONE IS WARM IN THE LIGHT AND COLD IN SHADOW, and spans a real value range.
// The first pass ran 0x9b9b9d to 0x707076: forty-three values of one blue-grey,
// which is a flat plastic wall at every angle. Limestone at the top, cooling
// and darkening to near-black at the root.
const STONE = 0xada79b;
const STONE_D = 0x827d74;
// AND NOT NEARLY AS DARK AS THEY LOOK LIKE THEY SHOULD BE. Measured off the
// render, a cliff painted from these ran luma 47 with a two-value spread over
// its whole 280-pixel drop - flat AND black, which is worse than the flat grey
// it replaced. The reason is that these are multiplied by a face shade (0.62 on
// a downward face) and then by the depth ramp below, on a surface the sun never
// reaches: three darkenings compounding on one already-dark albedo.
const STONE_DEEP = 0x6e6e68;
const STONE_ROOT = 0x585a56;
/** Ivy down the cliff face. Darker than the turf, or it reads as spilt grass. */
const VINE = 0x466f2d;
const VINE_D = 0x33501f;
/** Flagged paths across the plateau, and the paved square. */
const PATH = 0xb9b2a2;
const PATH_D = 0x9e9787;
/** Tilled soil: the garden plots between the houses. */
const TILL = 0x6a4a2c;
const TILL_D = 0x513716;
/** The stream and the fall. Pale, so it stays visible against the sky. */
const WATER = 0x8fd8ec;
const WATER_L = 0xbceaf6;

/** Per-voxel value jitter, so a face is not one flat colour. */
function shade(hex: number, k: number): number {
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((hex >> 8) & 255) * k));
  const b = Math.min(255, Math.round((hex & 255) * k));
  return (r << 16) | (g << 8) | b;
}

/** Deterministic 0..1 hash of a cell. No allocation, no rng stream to advance. */
function hash2(x: number, z: number, salt: number): number {
  let h = (x * 374761393 + z * 668265263 + salt * 2246822519) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------
// The layout, decided before a single voxel is painted
// ---------------------------------------------------------------------------

/**
 * WHERE EVERYTHING GOES, in world units in the island's own frame.
 *
 * Planned FIRST and separately from both the rock and the buildings, because
 * the paths are painted INTO the terrain (they are flagstones in the ground,
 * not props standing on it) and the terrain therefore has to know the plan
 * before it is built. It is also what lets the settlement be read at a glance
 * in one place rather than inferred from the order of eighty stamp calls.
 */
interface SkyPlan {
  /** Every building: what, where, which way it faces. */
  readonly buildings: ReadonlyArray<{ t: Template; x: number; z: number; yaw: number; s?: number }>;
  /** Path centrelines as [x0, z0, x1, z1], painted into the turf. */
  readonly paths: ReadonlyArray<readonly [number, number, number, number]>;
  readonly lamps: ReadonlyArray<{ x: number; z: number; yaw: number }>;
  readonly fences: ReadonlyArray<{ x: number; z: number; yaw: number }>;
  readonly trees: ReadonlyArray<{ t: Template; x: number; z: number; yaw: number; s: number }>;
  /** Tilled garden beds, painted into the turf by `buildRock`. */
  readonly plots: ReadonlyArray<{ x: number; z: number; r: number }>;
  /** Bearing the stream leaves on, and where its pool sits. */
  readonly fallAngle: number;
  /** The town square — what an NPC stands across from. */
  readonly focus: { x: number; z: number };
}

/**
 * The paved square in the middle. Nothing is built inside it but the tower and
 * the market, and every street runs to its rim.
 */
const PLAZA = 19;
/** The band the dwellings stand in, as fractions of the island radius. */
const HOUSE_IN = 0.34;
const HOUSE_OUT = 0.62;
/** ...and where the tree line starts, outboard of the last house. */
const TREE_RING = 0.74;
/** How many knots the dwellings are grouped into. */
const CLUSTERS = 9;

/**
 * A dwelling's footprint radius, in world units, for the placement search.
 *
 * MEASURED OFF THE MODEL AND NOT GUESSED: `skyCottage`'s widest plan is 8 cells
 * of half-width plus two of roof overhang, times `SV` (0.6) and the 1.2 stamp
 * scale, which is 7.2. The FIRST PASS claimed 7.5 and then tested new houses
 * against 8 — so two neighbours had to be 15.5 units apart while the row placed
 * them 10 apart, and every house after the first in each knot was silently
 * refused. The town came back with six buildings on a hundred-unit island.
 *
 * Claim and test with the SAME number, and space the row wider than twice it.
 */
const HOUSE_R = 7.2;

/**
 * Lay the town out: a tower over a paved square, dwellings CLUSTERED around it,
 * streets from the square to each cluster, gardens between them, a tree line at
 * the rim and a gate on one side.
 *
 * IT WAS A CLOCK FACE AND THAT WAS THE WORST THING ABOUT IT. The first pass put
 * nine identical cottages on one radius at one angular step, each turned to
 * face the middle, and from above (which is how anybody arriving by air sees
 * this place first) it read as eight copies of one asset arranged on a circle,
 * which is exactly what it was. The reference village is CLUSTERED: three or
 * four knots of two to four buildings, each knot sharing a rough axis, with
 * open ground and planting between the knots. That is what this builds now.
 *
 * IT IS STILL NOT A GRID, and that is deliberate rather than unfinished. The
 * art plans a street grid on a squarish plateau, which needs block subdivision
 * and party walls and a rectangle to sit on. What survives the translation to a
 * round island a player can walk is the thing that actually reads: a landmark
 * in the middle, roofs at several angles, streets converging, a tree line, and
 * a gate that tells you which side is the front.
 */
function planSkyhaven(seed: number, parts: SkyParts, lib: PropLib): SkyPlan {
  const rng = mulberry32(seed ^ 0x5c17);
  const buildings: Array<{ t: Template; x: number; z: number; yaw: number; s?: number }> = [];
  const paths: Array<readonly [number, number, number, number]> = [];
  const lamps: Array<{ x: number; z: number; yaw: number }> = [];
  const fences: Array<{ x: number; z: number; yaw: number }> = [];
  const trees: Array<{ t: Template; x: number; z: number; yaw: number; s: number }> = [];
  const plots: Array<{ x: number; z: number; r: number }> = [];
  const at = (a: number, d: number): [number, number] => [Math.sin(a) * d, Math.cos(a) * d];
  /** Everything already standing, so nothing is planted inside a wall. */
  const taken: Array<{ x: number; z: number; r: number }> = [];
  const free = (x: number, z: number, r: number): boolean =>
    !taken.some((t) => (t.x - x) ** 2 + (t.z - z) ** 2 < (t.r + r) ** 2);
  const claim = (x: number, z: number, r: number): void => { taken.push({ x, z, r }); };

  // -- the tower, dead centre ----------------------------------------------
  buildings.push({ t: parts.tower, x: 0, z: 0, yaw: rng() * 6.28, s: 1.25 });
  claim(0, 0, 7);

  // -- the market on the square --------------------------------------------
  {
    const a = rng() * 6.28;
    const [wx, wz] = at(a, PLAZA * 0.68);
    buildings.push({ t: parts.well, x: wx, z: wz, yaw: rng() * 6.28 });
    claim(wx, wz, 3);
    for (const off of [2.2, 4.3]) {
      const [sx, sz] = at(a + off, PLAZA * 0.72);
      buildings.push({ t: parts.stall, x: sx, z: sz, yaw: a + off + Math.PI });
      claim(sx, sz, 4);
    }
  }

  // -- the dwellings, in clusters ------------------------------------------
  const a0 = rng() * 6.28;
  let houses = 0;
  for (let c = 0; c < CLUSTERS; c++) {
    // Each knot gets a wedge of the compass and sits at its own distance, so
    // the band between the square and the tree line is occupied unevenly.
    const centre = a0 + (c / CLUSTERS) * Math.PI * 2 + (rng() - 0.5) * 0.5;
    const dist = ISLAND_R * (HOUSE_IN + rng() * (HOUSE_OUT - HOUSE_IN));
    // ONE AXIS PER KNOT, quantised to an eighth turn. Every roof in a knot
    // therefore runs the same way, which is what makes it read as a street
    // rather than as a heap, and only two or three axes appear on the island.
    const axis = Math.round((centre + Math.PI) / (Math.PI / 4)) * (Math.PI / 4);
    const count = 3 + Math.floor(rng() * 4);
    for (let k = 0; k < count; k++) {
      // Strung along a line across the knot's own bearing, which puts the row's
      // gable ends toward the square.
      const along = (k - (count - 1) / 2) * (HOUSE_R * 2.1 + rng() * 4);
      const px = Math.sin(centre) * dist + Math.cos(centre) * along;
      const pz = Math.cos(centre) * dist - Math.sin(centre) * along;
      if (!free(px, pz, HOUSE_R)) continue;
      const kind = (houses % 3) as 0 | 1 | 2;
      // Half the roofs shingle, half slate. See SHINGLE in world/sky-parts.ts:
      // it is the alternation, not the hue, that makes a knot read as separate
      // buildings from the air.
      buildings.push({
        // STAMPED AT 1.2. The cottages were modelled against the terrain's own
        // cell and came out small on a 107-unit island — the reference's
        // buildings are a sixth of the plateau across and ours were a tenth.
        // Scaling the stamp rather than the model keeps `SV`'s block gauge and
        // takes the collider with it (`SolidStamp.add`).
        t: parts.cottages[kind + (houses % 2 === 0 ? 0 : 3)],
        x: px, z: pz, yaw: axis + (rng() - 0.5) * 0.12, s: 1.2,
      });
      claim(px, pz, HOUSE_R);
      houses++;
      // A hedge at the foot of the wall, on the side away from the street.
      const bx = px + Math.sin(centre) * (HOUSE_R + 1.6);
      const bz = pz + Math.cos(centre) * (HOUSE_R + 1.6);
      if (free(bx, bz, 2)) {
        buildings.push({ t: parts.bushes[houses % 2], x: bx, z: bz, yaw: rng() * 6.28 });
        claim(bx, bz, 2);
      }
      // NO SMOKE. It was here and it is gone: `skySmoke` stamps six courses of
      // pale cube at the settlement's own 0.6 gauge, which is a seven-unit
      // column three cells thick, and placed by guessing where a chimney is
      // from the house's axis it came out as grey concrete pillars standing
      // beside the cottages rather than as anything leaving a stack. Smoke
      // wants to be small, translucent and attached to the model that has the
      // chimney; a solid prop the size of a garden shed is a worse artefact
      // than the missing detail it was added for. The builder is kept for
      // whoever does it properly.
    }
    // THE STREET to this knot, and a lamp halfway along it.
    const [px0, pz0] = at(centre, PLAZA);
    const [px1, pz1] = at(centre, dist - 6);
    paths.push([px0, pz0, px1, pz1]);
    const [lx, lz] = at(centre + 0.12, (PLAZA + dist) * 0.5);
    if (free(lx, lz, 2)) { lamps.push({ x: lx, z: lz, yaw: centre }); claim(lx, lz, 2); }
    // A GARDEN PLOT in the gap after the knot: tilled rows, which the reference
    // has between every group of houses and which is most of what makes the
    // ground between buildings look used rather than mown.
    const [gx, gz] = at(centre + Math.PI / CLUSTERS, dist * 0.92);
    if (free(gx, gz, 6)) { plots.push({ x: gx, z: gz, r: 5.5 }); claim(gx, gz, 6); }
  }

  // A ring road round the square, so the streets meet something rather than
  // radiating out of a point.
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    const b = ((k + 1) / 16) * Math.PI * 2;
    const [x0, z0] = at(a, PLAZA);
    const [x1, z1] = at(b, PLAZA);
    paths.push([x0, z0, x1, z1]);
  }

  // -- the gate, on the rim ------------------------------------------------
  // On its own bearing and pushed right out to the edge, because its whole job
  // is to break the rim's silhouette and say which side is the front.
  const gateAngle = a0 + Math.PI * 1.28;
  {
    const [gx, gz] = at(gateAngle, ISLAND_R * 0.9);
    buildings.push({ t: parts.gate, x: gx, z: gz, yaw: gateAngle, s: 1.2 });
    claim(gx, gz, 8);
    const [p0x, p0z] = at(gateAngle, PLAZA);
    paths.push([p0x, p0z, gx, gz]);
  }

  // -- trees ----------------------------------------------------------------
  // THE WORLD'S OWN OAKS, and deliberately NOT its pines: the overworld's
  // conifers carry a snow variant and came out capped in white on a green
  // island eighty units up, which reads as a bug rather than as weather.
  //
  // CLUMPED AND BIG. The first pass rang the island with 26 evenly-spaced
  // saplings at half scale: a necklace, and one that made the island look
  // smaller than it is. The reference has about fourteen trees with canopies
  // the size of a cottage, gathered into a wood on one side.
  const templates = [lib.oakA, lib.oakB, lib.oakC, lib.oakD];
  const woodAt = a0 + Math.PI * 0.55;
  for (let c = 0; c < 16; c++) {
    const centre = c < 8
      ? woodAt + (c - 3.5) * 0.34 + (rng() - 0.5) * 0.3
      : rng() * Math.PI * 2;
    const dist = ISLAND_R * TREE_RING + (rng() - 0.5) * ISLAND_R * 0.12;
    const n = 3 + Math.floor(rng() * 4);
    for (let k = 0; k < n; k++) {
      const a = centre + (rng() - 0.5) * 0.36;
      const d = dist + (rng() - 0.5) * 9;
      const [x, z] = at(a, d);
      if (!free(x, z, 4)) continue;
      trees.push({
        t: templates[Math.floor(rng() * templates.length)],
        x, z, yaw: rng() * 6.28, s: 0.85 + rng() * 0.35,
      });
      claim(x, z, 4);
    }
  }
  // Two or three specimens inside the town, which is what the reference has and
  // what stops the built-up part reading as a car park.
  for (let k = 0; k < 8; k++) {
    const a = rng() * Math.PI * 2;
    const [x, z] = at(a, ISLAND_R * (0.2 + rng() * 0.3));
    if (!free(x, z, 5)) continue;
    trees.push({
      t: templates[Math.floor(rng() * templates.length)],
      x, z, yaw: rng() * 6.28, s: 0.9 + rng() * 0.3,
    });
    claim(x, z, 5);
  }
  // ...and low planting scattered through the open ground, so no part of the
  // deck is bare mown lawn.
  for (let k = 0; k < 110; k++) {
    const a = rng() * Math.PI * 2;
    const [x, z] = at(a, ISLAND_R * (0.16 + rng() * 0.74));
    if (!free(x, z, 2.2)) continue;
    buildings.push({ t: parts.bushes[k % 2], x, z, yaw: rng() * 6.28 });
    claim(x, z, 2.2);
  }

  // -- the rim fence --------------------------------------------------------
  // Panels with gaps: it MARKS the edge, it does not close it. The island's
  // whole character is that it has an edge you can walk off, and a rail you
  // bump into would turn that into scenery.
  //
  // THE GAPS ARE HASHED, NOT PERIODIC. `k % 4 === 3` gives a three-on one-off
  // rhythm that is plainly legible as a repeat from above, which is the tell
  // that a fence was generated rather than built. A hash gives the same density
  // with no readable beat, and the panels lean a little.
  const fenceR = ISLAND_R * 0.93;
  const panels = Math.round((Math.PI * 2 * fenceR) / (7 * 0.6));
  for (let k = 0; k < panels; k++) {
    if (hash2(k, 0, 97) < 0.26) continue;
    const a = (k / panels) * Math.PI * 2;
    const x = Math.sin(a) * fenceR;
    const z = Math.cos(a) * fenceR;
    // Nothing across the gate, and nothing growing through a tree.
    if (!free(x, z, 2.4)) continue;
    fences.push({ x, z, yaw: a + Math.PI / 2 + (hash2(k, 1, 97) - 0.5) * 0.16 });
  }

  // THE FALL IS ON THE FRONT QUARTER, beside the gate, and that is a framing
  // decision rather than a geography one: the reference sheet leads with a
  // three-quarter view that has the gate and the waterfall in the same picture,
  // and a seed-derived bearing put ours behind the island in every shot.
  const fallAngle = gateAngle + Math.PI * 0.42;
  // The stream: from the square out to the rim on the fall's bearing, so the
  // waterfall has somewhere to have come FROM. Painted as water in the turf by
  // `buildRock`, which is why it is a path-shaped thing in the plan.
  const [fx, fz] = at(fallAngle, PLAZA * 0.9);
  return {
    buildings, paths, lamps, fences, trees, plots, fallAngle,
    focus: { x: fx * 0.4, z: fz * 0.4 },
  };
}

// ---------------------------------------------------------------------------
// The rock
// ---------------------------------------------------------------------------

/**
 * The island's outline, in cells, at a bearing.
 *
 * IRREGULAR ON PURPOSE. A circle of revolution is the one thing the reference is
 * not: its plateau is a rounded square with bites out of it, and the giveaway
 * that a landmass was generated is an outline whose curvature never changes.
 * Three harmonics — a four-lobed term that squares it off, a three-lobed one
 * that breaks the symmetry and a seventh that roughens the edge — and then the
 * cell grid quantises the result into the blocky coastline the art has.
 */
function outlineAt(theta: number, phase: number): number {
  return RC * (
    0.855
    // The four-lobe term is what SQUARES it off, and it has to be big to
    // survive quantisation: at 0.06 it is a 6.8% modulation of the radius,
    // which the cell grid smooths straight back into a disc. 0.15 gives four
    // distinguishable sides and four soft corners, which is the plan's shape.
    + 0.15 * Math.cos(4 * theta + phase)
    // A two-lobe bite, so one flank carries a real inlet and the island has a
    // front and a back rather than four identical faces.
    + 0.06 * Math.sin(2 * theta + phase * 0.4)
    + 0.055 * Math.sin(3 * theta + phase * 1.7)
    // ...and a seventh to rough the coastline. At 0.022 this did nothing.
    + 0.045 * Math.sin(7 * theta - phase)
  );
}

/**
 * How deep the rock goes under a column, in cells: sheer cliff, then a ledged
 * taper to the keel.
 *
 * The taper is QUANTISED to `LEDGE`, which is what gives the underside the
 * stepped shelves the reference has, and then roughened by a per-column hash so
 * the shelves are ragged rather than concentric.
 */
function depthAt(d01: number, gx: number, gz: number): number {
  // A CONE THAT ACCELERATES INWARD, so the keel comes to a ROOT rather than a
  // plate. `(1 - d^2)` was flat across the middle and only fell near the rim,
  // i.e. a dome upside down; `(1 - d)^0.9` is near-linear and still bottomed
  // out across 39% of the island's width. The exponent is what decides whether
  // the deepest points are a point or a floor.
  const taper = TAPER * Math.pow(Math.max(0, 1 - d01), 1.35);
  // ROUGHENED IN WHOLE LEDGES, then quantised. Doing it the other way round,
  // quantise and then add fractional noise, erases the terracing entirely: the
  // shelves have to move as shelves.
  //
  // HASHED COARSELY, at 11 cells, because a shelf has to READ as a shelf: at 5
  // the patches were 6 units across and the underside came out as vertical
  // corduroy rather than as a stack of horizontal plates.
  //
  // AND NOT AT ALL AT THE ROOT. A one-ledge wobble on the deepest columns is
  // exactly what turns the point back into a plateau, so it stops inside the
  // inner quarter.
  const wob = Math.round((hash2(Math.floor(gx / 11), Math.floor(gz / 11), 11) - 0.5) * 2);
  const wobble = d01 < 0.25 ? 0 : wob;
  const stepped = (Math.round(taper / LEDGE) + wobble) * LEDGE;
  return Math.max(2, CLIFF + Math.max(0, stepped));
}

// ---------------------------------------------------------------------------

/** Radial mesh resolution is gone; what is left is the parts bin. */
interface SkyParts {
  readonly tower: Template;
  /** Six: three plans, each with a slate roof and a shingle one. */
  readonly cottages: readonly Template[];
  readonly well: Template;
  readonly stall: Template;
  readonly fence: Template;
  readonly lamp: Template;
  readonly gate: Template;
  /** Two sizes of hedge, for the foot of a wall and for open ground. */
  readonly bushes: readonly Template[];
  readonly smoke: Template;
}

/**
 * A registry holding exactly one town, in the island's own coordinates.
 *
 * `Npcs` places people through a `TownRegistry` (world/npc.ts) and asks it for a
 * centre, a gate bearing and an outer radius. Handing it the island's LOCAL
 * town — centred on (0, 0), because that is where the island's origin is — is
 * what lets the whole NPC system be reused unchanged: the placement search, the
 * clearance tests, the conversation state and the culling all work in one frame
 * and never find out which one it is.
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
 * A road network with no roads in it. The deck has none, so every clearance
 * query is satisfied — which is what makes the NPC placement search's road test
 * a no-op here rather than a special case inside it.
 */
const NO_ROADS: RoadClearance = {
  distanceTo: () => Infinity,
  spanDistanceTo: () => Infinity,
};

export class SkyIsland extends CarrierBody implements NpcFrame {
  /** The settlement's public face — name, colour, radius. Its x/z are LIVE. */
  readonly town: SkyTownInfo;
  readonly npcs: Npcs | null;

  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];
  private readonly solids = new StructureField();
  /** Where the island wants to be, world x/z. Re-picked on arrival. */
  private tx = 0;
  private tz = 0;
  private vx = 0;
  private vz = 0;
  private readonly rng: () => number;
  /** The outline's phase, so two seeds are two different islands. */
  private readonly phase: number;

  constructor(
    private readonly terrain: Terrain,
    props: PropLib,
    data: SkyTownData,
    /** Where it wanders around, world x/z. */
    private readonly homeX: number,
    private readonly homeZ: number,
    seed: number,
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
      kind: 'hamlet',
      x: homeX,
      y: MIN_ALT,
      z: homeZ,
      radius: data.radius,
      outerRadius: ISLAND_R,
      // The GATE of a town you can only arrive at by air is its middle: there
      // is no road and no threshold, so a compass chip pointing at a notional
      // gate on the rim would point at a piece of empty grass. Kept on the
      // record rather than dropped because `TownInfo` is the quest-facing
      // contract and an objective must not have to ask which kind it is.
      gateX: homeX,
      gateZ: homeZ,
      gateAngle: 0,
      color: data.color,
      // No keep-out. It is not that the town does not deserve one — it is that
      // a spawn rule is a disc on the GROUND (see SafeZone), and this town is
      // not on the ground: nothing can spawn on the deck in the first place,
      // because every spawn path resolves its candidate against `getHeight`.
      noSpawnRadius: 0,
      carried: true,
    };

    // THE PLAN FIRST, because the paths and the stream are painted INTO the
    // rock and the rock cannot be built without knowing where they run.
    const parts: SkyParts = {
      tower: skyTower(),
      // Three plans by two roof materials. The layout picks `kind + 0` or
      // `kind + 3`, which is what alternates slate and shingle down a street.
      cottages: [
        skyCottage(0), skyCottage(1), skyCottage(2),
        skyCottage(0, true), skyCottage(1, true), skyCottage(2, true),
      ],
      well: skyWell(),
      stall: skyStall(),
      fence: skyFence(),
      lamp: skyLamp(),
      gate: skyGate(),
      bushes: [skyBush(false), skyBush(true)],
      smoke: skySmoke(),
    };
    const plan = planSkyhaven(seed, parts, props);
    this.buildRock(plan);

    // -- the settlement, in local coordinates -------------------------------
    const stamp = new SolidStamp(this.solids);
    const layout = content.factory<CarriedLayout>(CARRIED_LAYOUT_KIND, data.layout);
    layout?.(stamp, parts, plan);
    this.solids.build();
    this.emit(stamp.acc, props.solidMat, true, false);

    // -- the people ---------------------------------------------------------
    // Every query in the site is in the island's frame, so the placement search
    // walks rings around the island's own origin and tests the island's own
    // deck. `this` is the frame: `Npcs` transforms its records to world space
    // once a slice so that the talk test, which is asked in world space by
    // main.ts, keeps working with no branch in it.
    const site: NpcSite = {
      towns: localRegistry({ ...this.town, x: 0, z: 0, gateX: 0, gateZ: 0 }),
      roads: NO_ROADS,
      getHeight: () => 0,
      structureTopAt: (x, z) => this.solids.topAt(x, z),
      focusOf: () => plan.focus,
    };
    const crew = new Npcs(site, this);
    this.npcs = crew.all.length > 0 ? crew : null;
    if (this.npcs) this.root.add(crew.group);
    else crew.dispose();
  }

  // -- the shape ------------------------------------------------------------

  /**
   * THE WALKING SURFACE, in local coordinates — and it is a CONSTANT, because
   * the plateau is one flat course of turf.
   *
   * That is not a simplification of a heightfield, it is the design: a voxel
   * deck steps in whole cells (1.2 units) and `MAX_STEP_UP` is 0.5, so any
   * terrace on the plateau is a wall the player has to jump for no reason. The
   * cliff is where the height lives.
   *
   * -Infinity past the rim, which is what makes walking off one a fall.
   */
  deckAt(lx: number, lz: number): number {
    // ASKED OF THE CELL, NOT OF THE POINT, and that is what keeps the rim you
    // fall off exactly the rim you can see. The mesh is painted per column, so
    // a query that tested the continuous position would put the edge of the
    // ground up to half a cell away from the edge of the cube — you would walk
    // half a metre out over the drop, or fall half a metre short of it. Both
    // this and `buildRock` resolve the same cell centre through the same
    // `outlineAt`, so they cannot disagree.
    const gx = Math.floor(lx / CELL);
    const gz = Math.floor(lz / CELL);
    const wx = (gx + 0.5) * CELL;
    const wz = (gz + 0.5) * CELL;
    const d = Math.hypot(gx + 0.5, gz + 0.5);
    return d <= outlineAt(Math.atan2(wx, wz), this.phase) ? 0 : -Infinity;
  }

  /**
   * Top of everything a body can stand on, in local coordinates: the deck, and
   * whatever the settlement built on it.
   *
   * The same max a ground world takes between `getHeight` and `structureTopAt`,
   * made once here so a rider asks one question — see `CarrierRide.support`.
   */
  localTop(lx: number, lz: number): number {
    const deck = this.deckAt(lx, lz);
    if (deck === -Infinity) return -Infinity;
    let top = deck;
    const built = this.solids.topAt(lx, lz);
    if (built > top) top = built;
    // The residents block like everything else in a settlement — the same
    // primitive, measured off their own bodies (world/structures.ts) — and they
    // are a SECOND field for the reason world/index.ts takes a max of three:
    // a `StructureField` is frozen by `build()` at the end of its owner's
    // constructor, and the crew is placed after the town it is standing in.
    const who = this.npcs?.solids.topAt(lx, lz) ?? -Infinity;
    return who > top ? who : top;
  }

  // -- NpcFrame -------------------------------------------------------------
  // `toWorld`, `y` and `yaw` come from CarrierBody; the interface exists so
  // world/npc.ts can transform its records without importing a carrier.

  // -- flight ---------------------------------------------------------------

  protected steer(dt: number): void {
    // A STAGED CAPTURE HOLDS IT STILL. Same rule world/sway.ts applies to the
    // wind clock and for the same reason: two runs of `tools/shot-sky.mjs`
    // against one build have to produce the same six pictures, and an island
    // that has drifted four units between them is six frames nobody can
    // difference. It costs nothing in play — no URL a player loads carries it.
    if (flags.photo) return;
    // -- where to ------------------------------------------------------------
    const dx = this.tx - this.x;
    const dz = this.tz - this.z;
    if (dx * dx + dz * dz < ARRIVE * ARRIVE) this.pickDestination();

    const len = Math.max(1e-4, Math.hypot(dx, dz));
    const wantVX = (dx / len) * CRUISE;
    const wantVZ = (dz / len) * CRUISE;
    // Frame-rate independent, per the convention: an exponential approach and
    // never a fixed lerp. A mass this size takes about five seconds to settle
    // onto a new heading, which is what makes the turns read as drift.
    const k = 1 - Math.exp(-TURN_LAMBDA * dt);
    this.vx += (wantVX - this.vx) * k;
    this.vz += (wantVZ - this.vz) * k;
    this.x += this.vx * dt;
    this.z += this.vz * dt;

    // -- which way it points -------------------------------------------------
    // Rate-limited rather than damped, so the hull's turn is linear and slow.
    // It is the one motion a passenger standing on the deck feels through the
    // carrier's `dyaw`, and an exponential would spend most of it in the first
    // half-second where it reads as a lurch.
    const travel = Math.atan2(this.vx, this.vz);
    let turn = travel - this.yaw;
    while (turn > Math.PI) turn -= Math.PI * 2;
    while (turn < -Math.PI) turn += Math.PI * 2;
    const step = YAW_RATE * dt;
    this.yaw += Math.max(-step, Math.min(step, turn));

    // -- how high ------------------------------------------------------------
    // THE MOUNTAIN RULE. Not an avoidance behaviour: the keel is simply held
    // over the worst ground the island is about to be above, so there is no
    // approach angle at which the wander can put it into a peak. See the header.
    const want = Math.min(
      MAX_ALT, Math.max(MIN_ALT, this.groundBelow() + KEEL + KEEL_MARGIN),
    );
    const rise = CLIMB_RATE * dt;
    this.y += Math.max(-rise, Math.min(rise, want - this.y));
    this.town.x = this.x;
    this.town.y = this.y;
    this.town.z = this.z;
    this.town.gateX = this.x;
    this.town.gateZ = this.z;
  }

  /**
   * The highest ground under the island's footprint and along its heading.
   *
   * Thirteen samples a slice, which is a few hundred height-field evaluations a
   * second and inside the noise of one chunk build. The ring is at 0.72 of the
   * radius rather than at the rim because the keel tapers — the thing that
   * would hit a peak first is the deep middle of the root, not its skirt.
   */
  private groundBelow(): number {
    let top = this.terrain.getHeight(this.x, this.z);
    const ring = ISLAND_R * 0.72;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const h = this.terrain.getHeight(this.x + Math.sin(a) * ring, this.z + Math.cos(a) * ring);
      if (h > top) top = h;
    }
    // Ahead, along the way it is actually travelling rather than the way the
    // hull points — those differ through every turn, and it is the travel that
    // decides what it arrives over.
    const len = Math.max(1e-4, Math.hypot(this.vx, this.vz));
    const fx = this.vx / len;
    const fz = this.vz / len;
    for (let k = 1; k <= 4; k++) {
      const d = ISLAND_R * (1 + (LOOK_AHEAD - 1) * (k / 4));
      const h = this.terrain.getHeight(this.x + fx * d, this.z + fz * d);
      if (h > top) top = h;
    }
    return Math.max(top, WATER_LEVEL);
  }

  /** Somewhere else inside the roam disc, at least a third of it away. */
  private pickDestination(): void {
    for (let attempt = 0; attempt < 8; attempt++) {
      const a = this.rng() * Math.PI * 2;
      // sqrt of the roll, so the points are uniform over the AREA rather than
      // clustered in the middle — an island that spent most of its time near
      // home would be an island that never went anywhere.
      const d = Math.sqrt(this.rng()) * ROAM_R;
      const x = this.homeX + Math.sin(a) * d;
      const z = this.homeZ + Math.cos(a) * d;
      if ((x - this.x) ** 2 + (z - this.z) ** 2 < (ROAM_R * 0.34) ** 2) continue;
      this.tx = x;
      this.tz = z;
      return;
    }
    this.tx = this.homeX;
    this.tz = this.homeZ;
  }

  // -- frame ----------------------------------------------------------------

  /**
   * Pose the residents. Called from `World.update`, like the ground NPCs.
   *
   * The island's own motion is NOT here: it is in `advance`, which the carrier
   * registry runs at the top of the simulation slice rather than at the end of
   * it. See `CarrierRegistry.advance` for why the two are separated.
   */
  update(dt: number, time: number, focus: THREE.Vector3): void {
    this.npcs?.update(dt, time, focus);
  }

  setVisible(v: boolean): void {
    this.root.visible = v;
  }

  dispose(): void {
    this.npcs?.dispose();
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    this.geos.length = 0;
    this.mats.length = 0;
  }

  // -- geometry -------------------------------------------------------------

  /**
   * One accumulator -> one mesh under the island's root.
   *
   * `owned` says whether the MATERIAL is this island's to dispose. The town's
   * timber is stamped onto `PropLib.solidMat`, which belongs to the prop
   * library and is disposed with it; anything made here is made here. Getting
   * that backwards is a double dispose one way and a leak the other, which is
   * why it is an argument rather than a guess about the object.
   */
  private emit(acc: Accum, mat: THREE.Material, shadows: boolean, owned: boolean): void {
    const geo = acc.toGeometry();
    if (!geo) {
      if (owned) mat.dispose();
      return;
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    mesh.matrixAutoUpdate = false;
    this.root.add(mesh);
    this.geos.push(geo);
    if (owned) this.mats.push(mat);
  }

  /**
   * THE ROCK, as cubes.
   *
   * ONLY THE SHELL IS PAINTED. A filled island at this cell size is 300k
   * voxels, which is a second of boot and a hundred megabytes of Map for
   * material nobody can see; painting the surface only takes it to ~30k. The
   * rule is in `paintColumn`: a cell is painted when it is in the top courses,
   * when it is the bottom of its column, or when any neighbour is shallower —
   * i.e. exactly when a face of it can be seen.
   *
   * The mesh's own material comes from `VoxelModel.build`, which also emits a
   * separate glow batch for anything emissive. Nothing here is emissive; the
   * lit windows are in the settlement's models.
   *
   * NOT A STATIC SHADOW CASTER: the whole thing moves, and the cached half of
   * the shadow map is for geometry that is a pure function of the seed (see
   * core/shadow-cache.ts). An island wrongly marked static drags a frozen
   * shadow across the meadow behind it.
   */
  private buildRock(plan: SkyPlan): void {
    const v = new VoxelModel();
    const R = Math.ceil(RC) + 2;

    /** Distance in cells from a path centreline, for painting flagstones. */
    const onPath = (wx: number, wz: number): boolean => {
      for (const [x0, z0, x1, z1] of plan.paths) {
        const dx = x1 - x0;
        const dz = z1 - z0;
        const len2 = dx * dx + dz * dz;
        const t = len2 > 0
          ? Math.max(0, Math.min(1, ((wx - x0) * dx + (wz - z0) * dz) / len2))
          : 0;
        const px = x0 + dx * t;
        const pz = z0 + dz * t;
        // WIDE ENOUGH TO BE A STREET. At 1.7 these were dirt scratches that
        // barely showed against the turf from above; the reference's are
        // flagged streets with kerbs, wide enough for two people.
        if (Math.hypot(wx - px, wz - pz) < 2.9) return true;
      }
      return false;
    };

    /**
     * THE SQUARE IS PAVED, not worn. Everything inside `PLAZA` is flagstone,
     * which is what gives the middle of the town a floor and the tower
     * something to stand on — the first pass left a smudge of dirt paths
     * radiating out of a lawn.
     */
    const onPlaza = (wx: number, wz: number): boolean => wx * wx + wz * wz < PLAZA * PLAZA;

    /** Tilled beds. See `SkyPlan.plots`. */
    const onPlot = (wx: number, wz: number): boolean =>
      plan.plots.some((g) => (wx - g.x) ** 2 + (wz - g.z) ** 2 < g.r * g.r);

    /** The stream: a two-cell channel from the square to the rim. */
    const fx = Math.sin(plan.fallAngle);
    const fz = Math.cos(plan.fallAngle);
    const onStream = (wx: number, wz: number): boolean => {
      const along = wx * fx + wz * fz;
      if (along < PLAZA * 0.7 || along > ISLAND_R) return false;
      const across = Math.abs(wx * fz - wz * fx);
      return across < 1.9;
    };

    for (let gx = -R; gx <= R; gx++) {
      for (let gz = -R; gz <= R; gz++) {
        // Cell centres, so a column's world position is the middle of its cube.
        const wx = (gx + 0.5) * CELL;
        const wz = (gz + 0.5) * CELL;
        const d = Math.hypot(gx + 0.5, gz + 0.5);
        const edge = outlineAt(Math.atan2(wx, wz), this.phase);
        if (d > edge) continue;
        const d01 = Math.min(1, d / edge);
        const depth = depthAt(d01, gx, gz);
        // THE LIP: the turf reaches the outline and the stone stops one course
        // short of it, so the grass overhangs all the way round and prints a
        // hard shadow line under itself. Without it the green and the grey read
        // as one mass — see LIP.
        const stone = d <= edge - LIP;
        this.paintColumn(
          v, gx, gz, depth, stone,
          onStream(wx, wz) ? 'water'
            : onPlaza(wx, wz) || onPath(wx, wz) ? 'paved'
              : onPlot(wx, wz) ? 'tilled' : 'turf',
        );
      }
    }

    // -- the waterfall --------------------------------------------------------
    // Off the rim on the stream's bearing, falling past the keel and stopping.
    // Opaque cubes rather than a transparent sheet: everything else in this
    // world is opaque cubes, and a translucent quad here would be the one
    // surface in the game that is not.
    {
      // FROM THE RIM COLUMN, straight down, and narrowing as it goes. The first
      // pass walked it OUTWARD as it fell and started it half a cell past the
      // edge, so it hung in the air beside the island like a pipe with nothing
      // at the top of it — a fall has to leave a lip you can stand at and look
      // over, which means it starts on the last column of turf.
      const rimD = outlineAt(plan.fallAngle, this.phase) - 1;
      const gx0 = Math.round(Math.sin(plan.fallAngle) * rimD);
      const gz0 = Math.round(Math.cos(plan.fallAngle) * rimD);
      const perpX = Math.round(Math.cos(plan.fallAngle));
      const perpZ = -Math.round(Math.sin(plan.fallAngle));
      const FALL = 40;
      for (let k = 0; k < FALL; k++) {
        const gy = -1 - k;
        // A BROAD LIP THAT TAPERS TO A THREAD. A fall of constant width is a
        // pipe, which is exactly what the first two versions of this looked
        // like — the water has to spread where it leaves the rim and gather as
        // it drops.
        // WIDE ENOUGH TO BE WATER. At one and two cells the fall came back as
        // a pale WIRE hanging under the island in every side view — the eye
        // reads a 1.2-unit column at fifty units as a rendering artefact, not
        // as a river. Seven cells at the lip and five down the body is about a
        // sixth of the island's width, which is the proportion the reference's
        // fall has.
        // WIDE, AND IT DISSOLVES. A constant-width column is a ruler drawn on
        // the sky; running it past the deepest rock and stopping square is
        // worse still, which is what 52 courses did. It now ends inside the
        // keel's own depth and thins out over its last stretch.
        const w = k < 5 ? 4 : k < 24 ? 3 : 2;
        // ...and it WANDERS. A perfectly straight column reads as a ruler drawn
        // on the sky; one cell of drift every few courses is enough to break it
        // without the fall ever looking like it is being blown sideways.
        const drift = Math.round(Math.sin(k * 0.21) * 1.4);
        for (let t = -w; t <= w; t++) {
          const j = hash2(gx0 + t, gy, 41);
          // The tail breaks up rather than ending on a square edge.
          if (k > FALL - 10 && j < (k - (FALL - 10)) / 10) continue;
          // The head is white water and the body is blue: the brightest part of
          // a fall is where it breaks over the lip.
          const c = k < 5 || j < 0.35 ? WATER_L : WATER;
          v.set(
            gx0 + perpX * (t + drift), gy, gz0 + perpZ * (t + drift),
            shade(c, 0.95 + j * 0.16),
          );
        }
      }
      // MIST AT THE LIP, where it goes over. Four pale cells sitting on the
      // turf at the head of the fall, which is what tells you from above that
      // the stream ends in a drop rather than at a wall.
      for (let t = -2; t <= 2; t++) {
        for (let b = 0; b <= 1; b++) {
          if (hash2(t, b, 71) < 0.35) continue;
          v.set(gx0 + perpX * t - Math.round(Math.sin(plan.fallAngle)) * b, -1,
            gz0 + perpZ * t - Math.round(Math.cos(plan.fallAngle)) * b, shade(WATER_L, 1.02));
        }
      }
    }

    const mesh = v.build(CELL, false);
    // `build` re-bases the model so its LOWEST voxel sits at y = 0, i.e. a cell
    // at `gy` lands at `(gy - minY) * CELL`. The turf is course -1 and its TOP
    // face has to be local 0, which puts the whole model down by `minY * CELL`.
    // Read off the model rather than computed from CLIFF and TAPER, which the
    // roughness and the waterfall both reach past.
    mesh.position.y = v.bounds(false).minY * CELL;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.root.add(mesh);
    this.geos.push(mesh.geometry);
    this.mats.push(mesh.material as THREE.Material);
  }

  /**
   * One column of the island: turf (or flagstones, or the stream) on top, a
   * course of dirt, then stone down to `depth` — and only the cells whose faces
   * can be seen.
   *
   * `stone` is false for the outermost ring, which is what makes the turf
   * overhang; those columns are two courses of soil hanging over the drop.
   */
  private paintColumn(
    v: VoxelModel, gx: number, gz: number, depth: number, stone: boolean,
    surface: 'turf' | 'paved' | 'tilled' | 'water',
  ): void {
    const j = hash2(gx, gz, 7);
    // -- the surface course ---------------------------------------------------
    // FOUR GROUND MATERIALS, because the reference's plateau is not a lawn: it
    // is flagstone in the square and the streets, tilled rows in the gardens,
    // water in the channel, and turf in between. One of these per column is the
    // whole of the ground dressing and it costs nothing.
    let topC: number;
    if (surface === 'water') topC = shade(j < 0.4 ? WATER_L : WATER, 0.94 + j * 0.16);
    else if (surface === 'paved') topC = shade(j < 0.5 ? PATH : PATH_D, 0.94 + j * 0.14);
    // Tilled soil runs in ROWS rather than being a patch of brown: the furrow
    // is one cell of shadow every third one, which is what makes a plot read as
    // cultivated from the air rather than as a bald spot.
    else if (surface === 'tilled') topC = shade(gz % 3 === 0 ? TILL_D : TILL, 0.94 + j * 0.14);
    else {
      // A SECOND SALT ON A DIFFERENT LATTICE. Splitting the three greens on the
      // same `j` that drives the value jitter correlates them, and the open
      // lawn came out wearing a legible two-cell checkerboard.
      const g = hash2(gx * 3, gz * 7, 17);
      topC = shade(g < 0.18 ? GRASS_L : g < 0.68 ? GRASS : GRASS_D, 0.94 + j * 0.14);
    }
    v.set(gx, -1, gz, topC);
    // -- the dirt band --------------------------------------------------------
    v.set(gx, -2, gz, shade(j < 0.5 ? DIRT : DIRT_D, 0.92 + j * 0.2));
    if (!stone) {
      // An overhanging lip is soil all the way down its two courses; giving it
      // a third of stone would put grey under the grass at the one place the
      // dirt line is meant to read.
      v.set(gx, -3, gz, shade(DIRT_D, 0.9 + j * 0.2));
      return;
    }

    // -- the stone, shell only ------------------------------------------------
    // A cell is painted when a face of it can be seen: near the top, at the
    // bottom of its own column, or where a neighbour is shallower.
    const nb = [
      this.columnDepth(gx + 1, gz), this.columnDepth(gx - 1, gz),
      this.columnDepth(gx, gz + 1), this.columnDepth(gx, gz - 1),
    ];
    for (let k = 3; k <= depth; k++) {
      const bottom = k === depth;
      const exposed = bottom || k <= 4 || nb.some((n) => n < k);
      if (!exposed) continue;
      // A CONTINUOUS RAMP, not three buckets. The reference's underside is
      // dominated by shadow with only the shelf lips catching light; three even
      // steps of one hue gave a uniformly mid-grey keel with no form in it at
      // all. The colour walks four stops AND the value is pulled down by up to
      // 45% on the way, which is what gives the root its weight.
      const t = (k - 3) / Math.max(1, depth - 3);
      const c = t > 0.80 ? STONE_ROOT : t > 0.55 ? STONE_DEEP : t > 0.26 ? STONE_D : STONE;
      const jj = hash2(gx, gz - k * 31, 13);
      // The TOP face of a ledge is what catches the sky, so a course whose
      // neighbour is two shallower, a shelf rather than a wall, is lifted
      // rather than darkened.
      const shelf = nb.some((n) => n < k - 1) ? 1.14 : 1;
      // 0.32 rather than the 0.45 the first version of this ramp used: at 45%
      // the root went to near-black and lost its own terracing along with its
      // form, which trades one flat surface for a darker one.
      // 0.12, not the 0.32 this had: the ramp is stacking on a face the sun
      // already does not reach, and at a third the keel went to a silhouette
      // with no terracing visible in it at all.
      v.set(gx, -k, gz, shade(c, (0.86 + jj * 0.26) * (1 - 0.12 * t) * shelf));
    }

    // -- vines ----------------------------------------------------------------
    // Only where the column is on the rim — a strand hanging down the middle of
    // the island would be inside the rock. Six cells at most, because the
    // reference's ivy hangs from the turf line and gives out well before the
    // keel does.
    // AN ACCENT, NOT A COAT. At 55% of rim columns and up to twelve courses
    // each, the ivy covered the sheer band the whole silhouette rests on: the
    // middle of the cliff sampled as VINE rather than as stone. The reference
    // hangs it on about a fifth of the face, two to four courses, over legible
    // block coursing.
    if (nb.some((n) => n === 0) && hash2(gx, gz, 53) < 0.20) {
      const len = 2 + Math.floor(hash2(gx, gz, 59) * 3);
      for (let k = 3; k < 3 + len && k <= depth; k++) {
        v.set(gx, -k, gz, shade(hash2(gx, gz - k, 61) < 0.5 ? VINE : VINE_D, 0.9 + j * 0.2));
      }
    }
  }

  /** `depthAt` for a neighbour, or 0 where the neighbour is off the island. */
  private columnDepth(gx: number, gz: number): number {
    const wx = (gx + 0.5) * CELL;
    const wz = (gz + 0.5) * CELL;
    const d = Math.hypot(gx + 0.5, gz + 0.5);
    const edge = outlineAt(Math.atan2(wx, wz), this.phase);
    if (d > edge - LIP) return 0;
    return depthAt(Math.min(1, d / edge), gx, gz);
  }
}

// ---------------------------------------------------------------------------
// The town on it
// ---------------------------------------------------------------------------

/**
 * What a CARRIED town's layout is handed: a stamp that draws and blocks in one
 * call, the parts bin, and the plan.
 *
 * EVERY COORDINATE IS LOCAL — the island's own frame, origin at its centre —
 * which is what lets a layout be written exactly like a ground one while the
 * whole settlement is a thousand units away and moving. Compare `TownLayout` in
 * world/towns.ts: the difference is that this one is handed a PLAN rather than
 * a road network and a height field, because the plan had to exist before the
 * ground did (the paths are painted into the turf).
 */
export type CarriedLayout = (
  solid: SolidStamp,
  parts: SkyParts,
  plan: SkyPlan,
) => void;

/**
 * Skyhaven: a tower in the middle of a square, cottages on a ring facing it,
 * trees at the rim and a fence that marks the edge without closing it.
 *
 * It is deliberately NOT the Encampment's plan with the wall taken off. A camp
 * is defensive and faces inward against a palisade; an island has a horizon on
 * every bearing and nothing to defend against, so what stands at the edge is a
 * rail and a tree rather than a stake.
 *
 * Everything about WHERE is in `planSkyhaven`; this is only the stamping, which
 * is why it is three loops long. The split exists because the paths are part of
 * the terrain and the terrain is built before this runs.
 */
const buildSkyhaven: CarriedLayout = (solid, parts, plan) => {
  for (const b of plan.buildings) solid.add(b.t, b.x, 0, b.z, b.yaw, b.s ?? 1);
  for (const f of plan.fences) solid.add(parts.fence, f.x, 0, f.z, f.yaw);
  for (const l of plan.lamps) solid.add(parts.lamp, l.x, 0, l.z, l.yaw);
  // The trees go through the same stamp, so they are drawn into the same merged
  // mesh — but a tree template carries no `solid`, so nothing here blocks. That
  // is the same bargain the overworld makes with its own canopies: a trunk is a
  // collider only where the chunk registry says so, and the island has no chunk.
  for (const t of plan.trees) solid.add(t.t, t.x, 0, t.z, t.yaw, t.s);
};

/** The carried layouts this build implements. See `TownData.carried`. */
const CARRIED_LAYOUTS: Readonly<Record<string, CarriedLayout>> = {
  skyhaven: buildSkyhaven,
};

for (const [name, fn] of Object.entries(CARRIED_LAYOUTS)) {
  defineFactory(CARRIED_LAYOUT_KIND, name, fn);
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

/** `TownInfo` with the fields a moving town rewrites every slice. */
type SkyTownInfo = {
  -readonly [K in keyof TownInfo]: TownInfo[K];
};

interface SkyTownData {
  id: string;
  nameKey: TownInfo['nameKey'];
  layout: string;
  radius: number;
  color: number;
}

/**
 * The carried settlement in this content, or null when there is none.
 *
 * ONE, and the second is a diagnostic rather than a second island: the world
 * builds exactly one carrier today, and silently ignoring the extra asset is
 * how content gets authored against a feature that does not exist.
 */
export function readCarriedTown(): SkyTownData | null {
  let found: SkyTownData | null = null;
  for (const asset of content.all<TownData>('town')) {
    if (!asset.data.carried) continue;
    if (found) {
      reportContentIssue({
        severity: 'warn',
        code: 'bad-field',
        message: `"${asset.id}" is a second carried town; this world builds one`,
        assetId: asset.id, assetType: asset.type, pkg: asset.pkg, source: asset.source,
        field: 'data.carried',
        fix: 'one carried settlement per zone, for now',
      });
      continue;
    }
    const nameKey = displayKey(asset);
    if (nameKey === null) continue;
    found = {
      id: asset.id.slice(asset.type.length + 1),
      nameKey,
      layout: asset.data.layout,
      radius: asset.data.radius,
      color: asset.data.color,
    };
  }
  return found;
}
