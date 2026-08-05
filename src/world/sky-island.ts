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
 *   the DECK      `localDeck`, which is a CONSTANT — and that is the point. The
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
import { Waterfall } from './waterfall';
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
 *
 * 16, up from 12, MEASURED OFF THE HERO PAINTING rather than nudged: the sheer
 * coursed band there is about a quarter of the whole drop, and at 12 of 74 it
 * was a sixth — enough to see, not enough to read as the wall the town stands
 * on. `TAPER` came down by the same 4 so `KEEL` is untouched and the flight
 * altitudes above it did not have to move.
 */
const CLIFF = 16;

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
 *
 * 58 rather than 62 because `CLIFF` took the 4: the SUM is what the silhouette
 * and the flight rule both read, and 74 courses is 88.8 units against a 187-unit
 * width — 0.95 R of drop, which is what the reference sheet's panels 2 and 5
 * measure at (their keels bottom out at 0.42-0.50 of the island's width in
 * projection). Move either constant and move the other the opposite way, or the
 * island changes altitude for a reason that has nothing to do with altitude.
 */
const TAPER = 58;

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

/**
 * How deep a LIP column goes, in courses: turf, dirt, dirt, and no stone under
 * it — `paintColumn`'s `!stone` branch, which paints -1, -2, -3 and returns.
 *
 * Named because `localBottom` has to answer for those columns too and would
 * otherwise carry a 3 of its own, a metre from the overhang the whole
 * silhouette is built on.
 */
const LIP_COURSES = 3;

/**
 * How wide the grey rim-stone collar is, in cells, measured in from the outline.
 *
 * THE MOST PROMINENT OUTLINE FEATURE ON THE PLAN, AND IT WAS SIMPLY ABSENT.
 * `map-top.png` carries a ragged grey stone band right round the deck edge —
 * scanned radially from the disc's centre (622, 628) over 72 bearings it is
 * 30.3 px deep on a mean radius of 593.7 px, i.e. **5.1% of R**, and it is
 * present at every one of those bearings except the two the plan says it should
 * not be (the waterfall outflow and the dock). Captured (`shots/sky/4-topdown.png`,
 * fourth pass) there was not one grey pixel anywhere on our rim: turf ran to the
 * outline on every bearing and the only edge feature was the fence.
 *
 * 4 cells, NOT the 2.3 a note derived from an assumed R of 45 cells. `RC` is
 * `MAP_R * MAP_BLOCK` = 78, and 5.1% of 78 is 3.98. Read the radius from the
 * constant rather than from a remembered number.
 *
 * It is what SPEC.md §2 calls the rim lip seen from above: the top of the cliff,
 * end-on. So it is painted with the cliff's own stone rather than with a
 * material of its own — one rock, seen from two directions.
 */
const RIM_STONE = 4;

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
/**
 * Never lower than this above sea level, whatever the ground below says.
 *
 * IT CRUISES ABOVE THE WEATHER NOW. This was 112, which put the deck INSIDE the
 * cumulus bands (they run 80-142, see world/clouds.ts) and made every view of
 * the island a negotiation with a cloud — the keep-out bubble exists entirely
 * because of that. At 190 the deck is clear of the highest band's own top, so
 * the cloud deck lies UNDER the island the way it does in the reference art,
 * the keep-out becomes a no-op that costs one distance test, and the thing
 * reads as somewhere you have to climb to rather than as scenery at eye level.
 *
 * The keel is 89 units deep, so the root still hangs at 101 — a long way over
 * the highest ground in the world, which is what makes the altitude rule below
 * inert most of the time rather than fighting this floor.
 */
const MIN_ALT = 190;
/** ...and never higher. Nothing in the sky above this to make room for. */
const MAX_ALT = 215;
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
//
// AND IT WAS LIMESTONE, WHICH IS THE WRONG ROCK. `STONE` was 0xada79b — a pale
// warm beige — and captured (`shots/sky/1-front3q.png`, `2-side.png`, second
// pass) the cliff came back the colour of cardboard and the single lightest
// large surface in the frame after the sky, which inverts the reference's
// reading order: there the GRASS is the bright thing and the rock is the dark
// mass it sits on. The map's own sample is `#55554A` body over `#6E6E62` lit
// (SPEC.md §9), a dark cool grey; these sit a little above it because a `?`
// flag cannot un-darken what the face shade and the depth ramp below already
// take out, and the top of the cliff is the one part of the rock the sun
// genuinely reaches.
//
// AND THEN IT WAS CARDBOARD, WHICH IS THE SAME MISTAKE ONE STOP QUIETER.
// 0x6e6b5f / 0x605f57 were still a warm mid grey, and measured off the render
// (`shots/sky/2-side.png`, fourth pass, rock band x200-1150 y250-660) the cliff
// came back median luma 90, p25 78, only 5.0% of it below luma 45, mean #615a3f
// with R−B = **+33.8**. The reference's own sheer band (`ref-angles.png` panel
// 2, x570-880 y225-400) is median luma **55**, p25 44, 26.8% below 45, mean
// #3f423d with R−B = **+2.8** — a NEUTRAL grey whose largest channel is GREEN.
// Panel 5 agrees at #3d4239 / +3.7. Twice the value and ten times the yellow.
//
// SO THE ALBEDO HAS TO SIT NEGATIVE IN R−B TO LAND NEUTRAL. The sun is 0xffebbe
// and the grade is warm after it; measured across the four passes above, the
// pipeline adds about +19 to R−B between albedo and pixel. An albedo picked to
// look like the reference swatch renders +19 too warm, which is exactly how
// this block arrived at khaki twice. −4 in, +3 out.
//
// ...AND −4 IN WAS STILL SEVEN STOPS SHORT, because the offset is bigger than
// +19 and it EATS BLUE rather than adding red. Measured on the fifth pass
// (`shots/sky/2-side.png`, cliff band x300-1000 y250-400) an albedo of −4
// rendered **R−B +21 with B = 42**, and the lit flank at +26 with B = 49; the
// reference's own rock (`ref-angles.png` panel 2, x570-880 y240-400) is
// **R−B −22**, and its underside (panel 5, x620-840 y700-880) **−8**. Every
// sample of ours came back green-dominant with a starved blue, which is olive
// mud rather than stone, and it is why the collar, the cliff and the turf all
// read as one family in `1-front3q.png`.
//
// The pipeline's real transfer, measured across the whole colour block: R−B
// moves by about **+25** and the blue channel is multiplied by roughly **0.7**
// (the sun is 0xffebbe — B is 0.75 of R at source — and the grade is warm after
// it). So the albedo is picked BACKWARDS through that: −23 in to land near +2
// out, with B high enough that 0.7 of it still clears the 65 the reference sits
// at. These two are the same value they always were; only the hue moved.
const STONE = 0x3b4754;
const STONE_D = 0x36414e;
// AND NOT NEARLY AS DARK AS THEY LOOK LIKE THEY SHOULD BE. Measured off the
// render, a cliff painted from these ran luma 47 with a two-value spread over
// its whole 280-pixel drop - flat AND black, which is worse than the flat grey
// it replaced. The reason is that these are multiplied by a face shade (0.62 on
// a downward face) and then by the depth ramp below, on a surface the sun never
// reaches: three darkenings compounding on one already-dark albedo.
//
// THE VALUE RANGE IS IN THE LIGHT, NOT IN THE ALBEDO, and this is the third
// time that has had to be relearned in this block. The four stops now span only
// 1.4:1 (0x6e down to 0x4f, i.e. the map's own `#6E6E62` lit sample at the top
// of the cliff) and the depth ramp under them takes 10% more — a
// deliberately NARROW spread, because the renderer already multiplies each face
// by 0.62 (down), 0.80 (±Z), 0.88 (±X) or 1.00 (up) and then lights it with a
// sun that reaches the shelf tops and nothing else. A keel painted with a 3:1
// albedo range on top of that came back as beige flashes on black
// (`shots/sky/5-underside.png`, third pass): the two extremes of the frame, on
// one rock. What the albedo is for here is the HUE walk — warm dry stone at the
// cliff, cooling to a blue-grey at the root — and the strata that carry it are
// keyed on ABSOLUTE depth rather than a normalised one (see `paintColumn`),
// which is what stopped them printing as vertical corduroy.
//
// ...AND THE NARROW SPREAD WAS RIGHT WHILE THE PLACE IT WAS NARROW AROUND WAS
// NOT. Measured (`shots/sky/5-underside.png`, fourth pass, x100-1180 y60-700)
// the keel came back median luma **39** with **69.1%** of it below luma 45 and
// 7.7% above 95 — the black mass with tan flashes this block twice claims to
// have tuned away from, and the flashes themselves sampled #7b6f4c (R−B +47)
// against a field of #1c2325 with no legible strata between them at all.
// Reference panel 5 is median **53**, 32.2% below 45, 15.8% above 95: half our
// black and twice our mid-tone.
//
// SO THEY GO COOL BUT THEY DO NOT GO FAR IN VALUE, and the reason is worth
// stating because it is the ceiling on the whole underside problem. These two
// stops are the same rock on both sides of the silhouette: on `2-side.png` they
// are the keel's OUTER flank, sunlit and already reading 70, and on
// `5-underside.png` they are the same courses seen from below, where the risers
// point away from a sun 38 degrees up and read 29. Measured, that ratio is 2.4:1
// and NO albedo closes it — a stop bright enough to put the underside at 53 puts
// the side view's shelves past 100. Swept from 0x3d4643 to 0x6e7a74 the
// underside moved 25 -> 26 while the flank moved 63 -> 65, which is the shape of
// a lighting difference rather than an albedo one. What DOES move it is
// `STONE_SOFFIT` and `DEPTH_LIFT` below, and they are worth the plates between
// the risers rather than the field as a whole.
//
// SO SAY WHAT THIS DID NOT FIX. The two panels went 90 and 39 to **68 and 29**:
// both much closer to the reference's 55 and 53 in absolute terms, and a RATIO
// of 2.34:1 against the 2.31:1 that was rejected. Closing that ratio is not a
// colour job — it needs either the keel to catch more light (more terracing
// turned toward the sun, i.e. geometry) or the shading model to give an
// unlit vertical face more bounce, and neither is in this constant.
// 0x4a5450 / 0x485259 are where the PICTURE reads best under that limit:
// legible strata from below, no chalk from the side.
//
// ...AND THEN THE UNDERSIDE SHIPPED AS A BLACK MASS ANYWAY, which is the exact
// failure the whole brief names. Measured on the fifth pass
// (`shots/sky/5-underside.png`, the rock only, x200-900 y150-600): median luma
// **30**, p95 **86**, and **68.5%** of the keel below luma 45. Reference panel 5
// over its own rock (x620-840 y700-880) is median **48**, p95 **115**, **42.1%**
// below 45. Half the value, a third of the highlight range, and half again the
// near-black area — a player looking up sees an unlit silhouette.
//
// SO THE SWEEP THIS BLOCK ABANDONED IS TAKEN, and the paragraph above explains
// why it was abandoned and why that reasoning was incomplete. It is true that no
// albedo closes the 2.3:1 ratio between the two views; it does not follow that
// the albedo should sit where it leaves the DARKER of the two at 30. The ratio
// is closed from the other end at the same time — `SUN_SHADE_K` takes real value
// out of the flank the sun misses, so the side view can afford stone that is
// half again as light without going chalky. 1.45x, cool by the same −22 the two
// stops above are, and the two changes were captured together rather than one at
// a time.
//
// WHERE IT LANDED, measured on the same regions: `5-underside.png`'s rock
// (x200-900 y150-600) median **30 -> 42**, p95 **86 -> 175**, the share under
// luma 45 **68.5% -> 57.3%**. Taken apart, the LOWER two thirds (x350-880
// y420-700) is 53 / 191 / 36.9% against reference panel 5's own rock at 47 /
// 104 / 45.4%, i.e. at parity — and the shortfall that is left is entirely the
// band immediately under the rim (median 40, 67% under 45), which is inside the
// DECK'S OWN CAST SHADOW. That one is not an albedo problem and this file
// cannot reach it: raising `STONE` 18% moved it by one code value. The
// reference's equivalent band is bright because a painting may put light where
// it likes; a renderer with a 187-unit plateau over a 38-degree sun may not.
const STONE_DEEP = 0x76838d;
const STONE_ROOT = 0x717e8a;
/**
 * The stone of a face that is NOTHING BUT A SOFFIT, and it is deliberately the
 * brightest constant in this block by a wide margin.
 *
 * A −Y face is multiplied by 0.62 in `VoxelModel.build` and is the one
 * orientation a sun 38 degrees up can never reach, so it is lit by ambient and
 * bounce alone. MEASURED on the shipped frame that is worth about **0.16** of
 * what goes in: a soffit painted `STONE_ROOT` comes back near #1c2325, luma 33,
 * and no ramp, jitter or shade in this file moves it anywhere.
 *
 * The three passes before this one all tried the same answer — a MULTIPLIER on
 * the deep stops (1.4, then 2.5, then 2.6) — and it fails twice over. It clips:
 * `shade` saturates each channel at 255, so past about 3.3 the soffit goes
 * white and desaturates rather than getting brighter. And `shade` moves a whole
 * VOXEL, so any bottom cell that also has an open side face gets the lift on a
 * face the sun does reach — captured at a flat 2.6, every shelf lip in
 * `5-underside.png` came back a blown cream strip, the same tan-flash failure in
 * a new colour.
 *
 * A separate albedo has neither problem, and it says the true thing plainly: a
 * surface that only ever receives sky needs an albedo picked against the SKY,
 * which is why this one is the coolest constant here as well as the lightest.
 * The cells it applies to are exactly the ones whose four neighbours are all at
 * least as deep — buried on every side, and so incapable of showing it anywhere
 * but underneath.
 */
const STONE_SOFFIT = 0xa8b6bd;

/**
 * The collar's TOP FACE, and it is the one piece of rock with an albedo of its
 * own rather than the cliff's.
 *
 * THERE WAS NO GREY RING AND THAT IS THE MOST PROMINENT THING ON THE PLAN.
 * `map-top.png` draws a stone collar 1-2 blocks wide all the way round the deck
 * edge (SPEC.md §2, §9 `#6E6E62` at luma 110), and `RIM_STONE` above is the
 * geometry for it — but painted with the cliff's stops and the cliff's flank
 * tint, it came back at R−B **+54** on `1-front3q.png` (x350-900 y490-512):
 * exactly the olive family as the turf above it (+83) and the cliff below it
 * (+24), sitting at median luma 74 between the two. A dirt band, not stone. On
 * `4-topdown.png` no grey ring was discernible at any bearing.
 *
 * Two reasons the cliff's own numbers cannot do this job, and both are about
 * ORIENTATION. The collar is a HORIZONTAL face — `SUN_AZ_X`'s whole term is a
 * proxy for which way a VERTICAL cliff points, and a +Y face has the same
 * relationship to the sun on every bearing, so a warm/cool flank walk on it is
 * saying something untrue about it. And a +Y face takes the full 1.00 face shade
 * where the sheer band under it takes 0.88 and is grazed by the sun besides, so
 * the same albedo that reads as dark rock in profile reads as a lit kerb from
 * above only if it is allowed to.
 *
 * Picked through the same −23 the rest of the block is (see `STONE`), at a value
 * that clears the cliff below it by the 25 the collar needs to READ as a
 * separate material rather than as the top course of the same one.
 */
const RIM_TOP = 0x5e6b7d;

/**
 * THE ROCK HAS A LIT SIDE AND A SHADED SIDE, AND IT IS BAKED.
 *
 * Measured, the fourth pass had neither: `2-side.png`'s left flank ran median
 * luma 96 against the right flank's 89 — a SEVEN-value split — and `1-front3q`
 * was worse at 75 against 72. Both flanks read R−B +36. That is one flat value
 * all the way round, which is the flat-plastic read the whole colour block
 * exists to avoid. The hero painting splits by **17** in value (left cliff
 * median 53 with 18.3% above luma 95, right cliff median 36 with 0.4%) and by
 * **29** in hue (lit face R−B +27.3, shade face −1.9).
 *
 * Why the real sun does not do it: every face of this mesh is one of six axis
 * normals, `VoxelModel.build` gives ±X the SAME 0.88 face shade and ±Z the same
 * 0.80, and at the sun's 38 degrees of elevation a vertical cliff receives a
 * grazing fraction of it. The directional term that survives all that is worth
 * about six code values, which is what was measured.
 *
 * So it goes in the albedo. `buildRock` knows every column's outward bearing
 * for free — it already has `(gx, gz)` and the island's centre is the origin —
 * and that bearing IS the cliff's normal, in exactly the way `shelf` and
 * `under` already proxy face orientation from column topology.
 *
 * THE COST, STATED: the mesh is built once and the hull YAWS in flight, so the
 * baked light drifts against the real sun as the island turns. `YAW_RATE` is
 * slow enough that it is a change of hour rather than a flicker, a stylised
 * voxel island reads as painted rather than as simulated anyway, and the thing
 * it buys — a form you can see the shape of from any of the six angles — is not
 * available any other way at this face-normal resolution. Photo captures are
 * pinned at yaw 0 (`steer` returns early under `flags.photo`), which is also
 * what makes the numbers above repeatable.
 *
 * Sun azimuth is `SUN_OFFSET` (core/engine.ts, 170/160/113) flattened and
 * normalised: (0.833, 0.554), i.e. it comes from the +X +Z quadrant.
 */
const SUN_AZ_X = 0.833;
const SUN_AZ_Z = 0.554;
/** Multiplier on a column facing dead into the sun, and on one facing away. */
const SUN_LIT = 1.24;
const SUN_AWAY = 0.86;
/**
 * A SECOND multiplier on the away side, and it is what makes the two flanks
 * different SURFACES rather than two tints of one.
 *
 * `SUN_AWAY` alone is a 1.43:1 spread and it is not enough: measured on the
 * fifth pass (`shots/sky/2-side.png`), the shaded flank (x800-1140 y260-480) ran
 * p25/p50/p75 = **55/60/65** — a NINE-value interquartile over an area 340 px
 * across, with **1.7%** of it below luma 45 — against a lit flank (x150-480) of
 * 69/78/84. Seventeen values of median between the two sides and no shadow
 * anywhere in either. That is flat plastic, and it is the thing panels 2 and 5
 * of the reference are least like: the same two regions there measure 47/60/97
 * lit against 39/49/61 shaded, i.e. eleven values of median but **thirty-six**
 * of p75 and **18 points** more of the shaded side under luma 45.
 *
 * What the reference has that a tint cannot produce is OCCLUSION — the away side
 * is not a bluer grey, it is less light. So the cool half now multiplies as well
 * as tinting, linearly with how far round it faces: 1.0 at the terminator down
 * to 0.78 dead away, which with `SUN_AWAY` under it is 0.655 against the lit
 * side's 1.20. 0.78 rather than the 0.72 that was captured first, because the
 * SAME term reaches the underside — half of `5-underside.png` is away-facing —
 * and at 0.72 the fix for the flank took back a fifth of the fix for the keel.
 *
 * IT IS A KNEE AND NOT A RAMP, and the version that was a ramp is why. A linear
 * walk to 0.78 at DEAD away compounds with the renderer, which has already taken
 * the direct term off every face past the terminator — and the two together are
 * multiplicative. Captured (`shots/sky/3-rear3q.png`, x300-900 y530-620, whose
 * camera sits at facing −0.975) the back cliff came back at median luma **20**
 * with **98.5%** of it under 45: a black cut-out, against 62 and 16.3% on the
 * reference's own back cliff (`ref-angles.png` panel 3). One criticism answered
 * into another.
 *
 * So the bake reaches full strength at the terminator's own shoulder
 * (`SUN_KNEE`) and then goes the OTHER WAY. Past that shoulder there is no
 * direct sun left for a bake to modulate — what lights that rock is bounce off
 * the sky and off the rest of the island, which a big open face gets plenty of
 * and which the renderer's ambient under-states. `SUN_BOUNCE` is that, and it is
 * the only term in this file that makes a surface brighter for facing away.
 */
const SUN_SHADE_K = 0.80;
const SUN_KNEE = 0.45;
const SUN_BOUNCE = 2.30;
// Measured across the whole knee, on `2-side.png` (whose visible flanks run
// facing +0.61 to -0.34) and `3-rear3q.png` (facing -0.98): lit flank
// p25/p50/p75 **65/80/99** against a shaded flank of 55/64/79 — an
// interquartile of 34 and 24 where the fifth pass had 16 and 10 — and the back
// cliff **20 -> 44** with the share under luma 45 going 98.3% -> 55.3%.
/**
 * ...and the hue the two ends walk toward. Warm noon stone, cold sky bounce.
 *
 * THE WARM END IS A GREY AND IT USED TO BE A TAN. 0xc9a56d is R−B **+92**, and
 * one fifth of the way toward it is most of why every rock sample in the fifth
 * pass came back olive (see `STONE`). A lit face of dry stone at noon is warm by
 * a few points, not by a third of the colour wheel: 0xb8a88e is R−B +42, which
 * at `SUN_WARM_MIX` is worth about +6 to the albedo and +6 to the pixel.
 */
const ROCK_WARM = 0xb8a88e;
const ROCK_COOL = 0x2e4666;
/**
 * How far toward each of those a fully-facing column goes.
 *
 * ASYMMETRIC, and the asymmetry was MEASURED OUT rather than reasoned to. The
 * target is a lit flank at R−B ≥ +20 and a shaded flank at ≤ 0, and the first
 * pass at it assumed the pipeline's +19 offset (see `STONE`) is a constant it
 * could subtract. It is not: it scales with how much light a face gets, so the
 * SAME albedo shift is worth about +15 on the lit flank of `2-side.png` and
 * about +29 on the shaded one. Swept across four captures, 0.20 toward a
 * warm 0xc9a56d lands the lit flank at **+27.9** and 0.90 toward a cool
 * 0x2e4666 lands the shaded one at **+12.7** — and 12.7 is a FLOOR rather than
 * a stop on the way down: 0.62 and 0.90 measured 13.9 and 12.7, i.e. half again
 * the tint bought one code value. Under a sun of 0xffebbe and a warm grade,
 * nothing short of a frankly blue rock gets a lit surface here to R−B 0.
 *
 * Note the cool target is DARK (luma 66) where the warm one is light (168).
 * That is deliberate: the tint is a hue walk and the value walk is `SUN_LIT` /
 * `SUN_AWAY`, so a bright cool target would have undone the shaded flank's
 * value at exactly the mix that fixes its hue.
 */
/**
 * BOTH ENDS CAME DOWN WHEN THE BASE STONE WENT COOL, and that is a consequence
 * rather than a second opinion. The measurements above were taken against an
 * albedo sitting at R−B −4, where the tint was doing the whole of the hue walk
 * on its own and 0.90 toward a dark blue was the only way to reach a shaded
 * flank that was not warm. `STONE` is −23 now, so the tint starts most of the
 * way there and 0.90 would over-shoot into a blue rock — 0.45 lands the shaded
 * flank in the same place from a different direction, and leaves the tint doing
 * what it is for (a hue DIFFERENCE between the flanks) rather than carrying the
 * material's own colour.
 */
const SUN_WARM_MIX = 0.16;
const SUN_COOL_MIX = 0.40;

/**
 * How much BRIGHTER the albedo gets with depth — and it used to get darker.
 *
 * The ramp under `paintColumn`'s four stops ran `(1 − 0.10 * u)` for three
 * passes and was argued down to 0.04 for a fourth, always in the same
 * direction: deeper is darker, because that is what stone in a hole does.
 * MEASURED, THE ISLAND IS NOT A HOLE AND THE ASSUMPTION IS BACKWARDS.
 *
 * The sheer band came back at median luma 90 against the keel's 39 — a
 * **2.31:1** split where the reference's own two panels are 55 and 53, i.e.
 * **1.04:1** — so a player circling the fourth pass saw a pale slab above an
 * unrelated black mass. A diagnostic capture (every keel cell painted by
 * category: soffits magenta, shelf lips green, riser walls blue) settled where
 * that 39 comes from and it is not where three comment blocks in this file
 * guessed: `5-underside.png` is overwhelmingly RISER WALL, the vertical face of
 * each terrace step, with the true soffits a small plum fraction between them.
 * A riser's normal is horizontal, half of them point away from a sun 38 degrees
 * up, and those get ambient and bounce and nothing else.
 *
 * So the light does not fall off with depth here, it falls off with WHICH WAY
 * the rock faces — and an albedo ramp that darkens with depth was compounding
 * on a shortfall it did not cause. Turned round it does the one thing an albedo
 * can do about a face the sun cannot reach: put more back in.
 *
 * 0.15 AND NOT MORE, and the ceiling is the SIDE view: the outer flank of the
 * keel is the same deep stone at the same `u` and IS sunlit, so every point of
 * lift here is also a point on `2-side.png`'s shelves. 0.28 and 0.30 were both
 * captured and both put the ROOT — the deepest, most `u`-lifted courses — at the
 * top of the frame's value range, which reads as a cream pedestal under a dark
 * cliff and inverts `ref-hero.png`, where the mass gets darker all the way down.
 * It closes the two panels toward each other; it cannot make either right on
 * its own.
 *
 * 0.24 now, and the ceiling the paragraph above describes MOVED. What made 0.28
 * a cream pedestal was the side view's shelves, and the side view has since
 * given up real value on the flank the sun misses (`SUN_SHADE_K`) — so the same
 * lift lands on a darker surface than the one it was rejected against. Held
 * under the 0.28 that was captured rather than taken to it, because the
 * measurement that rejected it was about the ROOT specifically and the root is
 * the one place this ramp is at full strength.
 *
 * ...AND THEN CAPTURED AT 0.24 IT WAS THE PEDESTAL AGAIN, which is the third
 * time this number has been measured and the first time the measurement was of
 * the right thing. `2-side.png`'s deep keel band (x450-900 y470-650) came back
 * median **125** with **61%** of it over luma 95 — not a highlight, a field —
 * because the ramp, the shelf lift and the sun term all MULTIPLY: 1.24 x 1.34 x
 * 1.13 is 1.88 on an albedo that had itself just gone up by half. 0.12 is what
 * is left once the albedo is carrying the value it used to be asked to add.
 */
const DEPTH_LIFT = 0.12;
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

/**
 * Walk a colour a fraction of the way toward another one.
 *
 * The hue half of the sun term. `shade` can only move VALUE — it is one
 * multiplier on all three channels — and a lit face and a shaded face differ in
 * hue by 29 code values of R−B in the reference (see `SUN_AZ_X`), which no
 * multiplier can produce.
 */
function tintTo(hex: number, target: number, t: number): number {
  const r = ((hex >> 16) & 255) + (((target >> 16) & 255) - ((hex >> 16) & 255)) * t;
  const g = ((hex >> 8) & 255) + (((target >> 8) & 255) - ((hex >> 8) & 255)) * t;
  const b = (hex & 255) + ((target & 255) - (hex & 255)) * t;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
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
/**
 * @param onDeck Is there ground under this point? THE PLAN HAS TO BE ABLE TO
 *   ASK. Everything here used to be placed on a radius — a fence at 0.93 of the
 *   radius, trees at 0.74 — which is exact only if the island is a circle, and
 *   it deliberately is not: `outlineAt` carries four harmonics summing to as
 *   much as a third of the radius, so a ring drawn at a constant fraction is
 *   inside the land on one bearing and out over the drop on the next. That is
 *   the fence hanging in mid-air over the void.
 * @param rimAt The rim's world radius at a bearing, so the fence can follow the
 *   coast instead of cutting across it.
 */
function planSkyhaven(
  seed: number, parts: SkyParts, lib: PropLib,
  onDeck: (x: number, z: number) => boolean,
  rimAt: (bearing: number) => number,
): SkyPlan {
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
  // ONE CONTINUOUS RAIL, WALKED ALONG THE ACTUAL COAST. It marks the edge; it
  // does not close it — the rail is low, and the breaks at the gate and at
  // whatever the tree line put on the rim are real openings.
  //
  // IT USED TO BE A CIRCLE AND THE ISLAND IS NOT ONE. Panels were placed at a
  // constant `ISLAND_R * 0.93`, which is inside the land on one bearing and out
  // over the drop on the next, because `outlineAt` carries four harmonics
  // summing to as much as a third of the radius. Whole runs of fence hung in
  // open air past the cliff. So the rim is WALKED: step the bearing finely,
  // take the coast's own radius at each step, and drop a panel every time the
  // accumulated distance reaches one panel's length. That also fixes the
  // spacing, which a constant angular step gets wrong the moment the radius
  // varies — the same number of panels over a longer arc is a gappy fence.
  //
  // THE YAW IS THE DIRECTION OF TRAVEL. `skyFence` paints along its local +X
  // and the stamp maps local +X to world (cos yaw, -sin yaw), so a panel lies
  // along a heading (ux, uz) exactly when `yaw = atan2(-uz, ux)`. It was the
  // bearing plus a quarter turn once, which maps +X to the RADIAL direction: a
  // ring of rails standing out over the edge like the spokes of a wheel.
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
      if (d < SPACING) continue;
      const ux = dx / d;
      const uz = dz / d;
      const mx = (x + lx) * 0.5;
      const mz = (z + lz) * 0.5;
      lx = x;
      lz = z;
      // BOTH ENDS ON GROUND, not just the middle. A panel is a straight chord
      // across a curve, so on a tight inside bend its ends reach further out
      // than its centre does — testing the centre alone is what would leave the
      // corners of a run poking off the cliff.
      const hx = ux * SPACING * 0.5;
      const hz = uz * SPACING * 0.5;
      if (!onDeck(mx - hx, mz - hz) || !onDeck(mx + hx, mz + hz)) continue;
      // ...and nothing across the gate, or through whatever else claimed the rim.
      if (!free(mx, mz, 1.2)) continue;
      fences.push({ x: mx, z: mz, yaw: Math.atan2(-uz, ux) });
    }
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
 * IT IS A DISC, AND THE VERSION BEFORE THIS ONE WAS A ROUNDED SQUARE ON
 * PURPOSE. That was the single most misread thing about the plan. The previous
 * comment here argued that "a circle of revolution is the one thing the
 * reference is not" and ran a mean of 0.855 RC with four harmonics summing to a
 * possible ±0.31 — so the island was up to 15% SMALLER than the plan draws it
 * and, captured from above, read as an amoeba where `map-top.png` reads as a
 * disc. Measured off that map over 96 rows (SPEC.md §1): between bearings 300
 * and 090 the outline sits at 1.00 R ± 0.03 R with no lobing you can see, and
 * nothing anywhere cuts more than 0.10 R into it.
 *
 * ...AND THEN IT WAS A CIRCLE, WHICH IS THE OTHER WAY TO MISREAD IT. Correcting
 * the envelope down to ±0.026 left an outline whose whole departure from a disc
 * was under the one-cell quantisation, plus two hand-placed gaussians BOTH
 * inside compass 150-220 — so three quarters of the coastline was a circle to
 * within 1.2 cells and `shots/sky/4-topdown.png` came back a clean ellipse.
 * The map is neither: it is a small envelope with a HIGH-VARIANCE, STAGGERED
 * edge inside it, and the mechanism for that is below.
 *
 * So: mean 0.960, a per-sector stagger, three harmonics summing to 0.038, and
 * the two real departures the map does have, both on the south flank.
 *
 * NOTHING TERRAIN EVER REACHES 1.00 R, and that is a contract rather than a
 * rounding. The only two things on the plan that stick out past the turf are
 * the gate causeway (1.02 R) and the dock platform (1.03 R), both of them
 * timber standing on nothing; and `CarrierBody`'s ride volume is `ISLAND_R`
 * exactly, so a coastline that overshot it would put walkable deck outside the
 * radius `tools/test-carrier.mjs` steps off at. 0.972 + 0.026 = 0.998.
 */
function outlineAt(theta: number, phase: number): number {
  // `theta` is `atan2(x, z)`, so 0 is +Z, which is compass SOUTH — the whole
  // file measures angles this way (see the TRAP note in SPEC.md §0) and compass
  // bearing B is 180 − theta in degrees.
  let t = theta;
  while (t > Math.PI) t -= Math.PI * 2;
  while (t < -Math.PI) t += Math.PI * 2;
  // THE SOUTHERN CHORD, and it is NOT turned by the seed. The map flattens the
  // outline to 0.92-0.95 R between compass 150 and 220 — the largest departure
  // from a circle anywhere on the plan, and a gentle chord rather than a bite.
  // Compass 185 is theta −0.09, so the gaussian sits there; a phase term would
  // roll it onto whichever of the gate (180) or the fall (138) the seed landed
  // on, and both of those are pinned by the plan.
  const chord = 0.024 * Math.exp(-(((t + 0.09) / 0.62) ** 2));
  // ...with one shallow scallop inside it at compass 205 (theta −0.44), which is
  // where the map reaches in furthest. Both are HALF what they were, because the
  // stagger below now supplies most of the departure from a circle and two
  // mechanisms aiming at the same 0.90 floor would reach it together.
  const scallop = 0.018 * Math.exp(-(((t + 0.44) / 0.22) ** 2));
  // THE COASTLINE IS A STAGGER, NOT A WOBBLE, and getting that wrong is what
  // made three quarters of the fourth pass's outline a circle to within one
  // cell. Measured over 72 bearings the map's r/R has standard deviation
  // **0.0344** inside a range of only 0.94-1.04 — and those two numbers together
  // say the departures are not sinusoidal. A sine spends most of its time near
  // its mean; to get sd 0.034 out of harmonics bounded at ±0.05 they would have
  // to be very nearly a square wave. What the map actually draws is what SPEC.md
  // §1 says: the edge steps in staggers of 2-3 map-blocks, holds, and steps
  // again. So does this — one hashed offset per sector of about three
  // map-blocks of arc (9 cells at `RC` = 78, i.e. 54 sectors), drawn from three
  // discrete levels.
  //
  // The three levels were picked by SCANNING THE RESULT, not by taste: 72
  // bearings at four seed phases give r/R (against each island's own peak) a
  // standard deviation of **0.0308 to 0.0342** with a minimum of 0.886 to
  // 0.901, against the map's own 0.0344 over a range of 0.94-1.04. The previous
  // version ran three harmonics summing to 0.026 for a total sd of about 0.018 —
  // UNDER the one-cell quantisation of 0.013, which is why
  // `shots/sky/4-topdown.png` came back a clean ellipse however the numbers were
  // read. The harmonics are back to being what they always claimed to be, a slow
  // bend under the staggers.
  const sector = Math.floor(((t + Math.PI) / (Math.PI * 2)) * 54);
  const lev = hash2(sector, 0, 29);
  const stagger = lev < 0.34 ? 0 : lev < 0.67 ? -0.042 : -0.082;
  const r = 0.960
    - chord - scallop + stagger
    // Three odd harmonics, seeded: the slow bend the staggers sit on, so the
    // sectors are not a comb about a perfect circle. They sum to 0.038, which
    // with the mean of 0.960 is what pins the PEAK at 0.998.
    + 0.016 * Math.sin(3 * theta + phase * 1.7)
    + 0.013 * Math.sin(7 * theta - phase)
    + 0.009 * Math.sin(11 * theta + phase * 0.6);
  // CLAMPED AT BOTH ENDS, and both ends are contracts rather than taste. 0.998
  // is `CarrierBody`'s ride volume less a rounding (see the header above);
  // 0.885 is SPEC.md §1's "nothing cuts more than 0.10 R into the disc" measured
  // against the PEAK rather than against the mean, which is where the three
  // independent inward terms would otherwise land together on whichever bearing
  // they happen to align on. It bites on a handful of sectors per seed and that
  // is intended — the map has short flats in it too.
  return RC * Math.max(0.885, Math.min(0.998, r));
}

/**
 * How deep the rock goes under a column, in cells: sheer cliff, then a ledged
 * taper to the keel.
 *
 * The taper is QUANTISED to `LEDGE`, which is what gives the underside the
 * stepped shelves the reference has, and then roughened by a per-column hash so
 * the shelves are ragged rather than concentric.
 */
/**
 * How far the turf overhangs the stone at a column, in cells — `LIP`, and a
 * cell more on about a third of the rim.
 *
 * THE RAGGED GREY RING IS THE POINT. A uniform one-cell setback gives a
 * perfectly concentric collar, and a collar whose offset never changes is the
 * same tell as an outline whose curvature never changes: from above it reads as
 * a machined edge with grass laid on it. Hashed at half resolution so a notch is
 * two cells wide and survives being seen from a radius and a half away — at full
 * resolution it is per-cell salt and disappears into the coastline's own
 * quantisation.
 *
 * Both `buildRock` and `columnDepth` resolve it through here, for the same
 * reason `localDeck` and `buildRock` share `outlineAt`: two formulas that agree
 * today are a seam, one function is not.
 */
function lipAt(gx: number, gz: number): number {
  return LIP + (hash2(Math.floor(gx / 2), Math.floor(gz / 2), 83) < 0.3 ? 1 : 0);
}

/**
 * Where a column sits between the centre and the rim, 0..1 — but resolved on a
 * TWO-CELL LATTICE, which is what the keel's shelves are cut on.
 *
 * THE UNDERSIDE WAS CORDUROY AND THE COLOUR RAMP WAS ONLY HALF OF IT. The other
 * half is geometry, and it is the thing `LEDGE` cannot fix by itself: a terrace
 * boundary is a ring in the plan, the ring runs diagonally across a square grid,
 * and quantised per cell it comes out as a staircase of ONE-CELL notches — each
 * of which exposes a one-cell-wide, five-course-tall face. Twelve terraces of
 * those is a hairbrush (`shots/sky/5-underside.png`, second and third passes),
 * and every one of the notches is real geometry, so no amount of recolouring
 * touches it.
 *
 * Cut on a two-cell lattice the notches are twice as wide and half as many,
 * which is the chunky blocky shelf the reference sheet's panel 5 is made of.
 * The TURF's outline stays at one cell — the coastline wants the finer gauge and
 * SPEC.md §1 says so; it is only the keel that wanted the coarser one.
 *
 * Both `buildRock` and `columnDepth` resolve through here for the usual reason:
 * `paintColumn`'s exposure test compares a column's depth against its
 * neighbours', so a lattice one of them did not know about would paint faces
 * that are not there and hide faces that are.
 */
function keelD01(gx: number, gz: number, phase: number): number {
  const bx = Math.floor(gx / 2) * 2 + 1;
  const bz = Math.floor(gz / 2) * 2 + 1;
  const d = Math.hypot(bx, bz);
  return Math.min(1, d / outlineAt(Math.atan2(bx * CELL, bz * CELL), phase));
}

function depthAt(d01: number, gx: number, gz: number): number {
  // A CONE THAT ACCELERATES INWARD, so the keel comes to a ROOT rather than a
  // plate. `(1 - d^2)` was flat across the middle and only fell near the rim,
  // i.e. a dome upside down; `(1 - d)^0.9` is near-linear and still bottomed
  // out across 39% of the island's width. The exponent is what decides whether
  // the deepest points are a point or a floor.
  //
  // 1.08 rather than 1.35, and the correction is to the SILHOUETTE rather than
  // to the root. At 1.35 the profile is flat across the middle and falls away
  // steeply just inside the rim — the depth is concentrated in a spike, and
  // captured from a distance (`shots/sky/6-distant.png`, second pass) the
  // island read as a shallow lens with a bump under it rather than as the
  // straight-sided pyramid panels 2 and 5 of the reference sheet show. A little
  // over 1 keeps the sides near-straight, which is what the art has, and the
  // flat bottom that 0.9 was blamed for is 7% of the radius at this `LEDGE`,
  // not 39%: with the taper quantised to 5 the deepest shelf covers exactly
  // the columns whose taper rounds to 12 ledges, i.e. d01 < 0.07.
  //
  // 1.12, AND THE NUMBER CAME OUT OF MEASURING THE ART RATHER THAN OF TASTE.
  // The question the exponent answers is: how wide is the keel HALF WAY DOWN?
  // On panel 2 of the reference sheet the mass at half the drop is about 0.55 of
  // the island's own radius, and `(1 - d01)^p = 0.5` at `d01 = 0.45` solves to
  // p = 1.16. 1.35 puts it at 0.60 R and, worse, spends the whole outer half of
  // the island on a thin skirt: captured from a distance the island read as a
  // lens with a bump under it (`shots/sky/6-distant.png`, second pass). 0.82 was
  // tried in the other direction on a misreading — that the reference's keel
  // "stays wide and then converges" — and gives 0.70 R at half depth, which
  // renders as a bucket with a flat plate under it and no terracing visible from
  // the side at all. A little over 1 is a cone, which is what the art is.
  //
  // The MIDDLE is untouched by any of this, so `KEEL` and every flight altitude
  // derived from it are the same at every exponent.
  // 1.55, AND THE 1.12 ABOVE WAS THE RIGHT ARITHMETIC ON THE WRONG QUANTITY.
  // `(1 − d01)^p` is the DEPTH profile; what a silhouette shows is the WIDTH at
  // a given depth, and the two are inverses. Solving the paragraph above for the
  // width at half the drop gives `d01 = 1 − 0.5^(1/p)`, i.e. 0.46 R at p = 1.12
  // — which sounds like an over-shoot of the 0.55 target and is not, because
  // every column in between is still full depth: the mass at half the drop is
  // bounded by the OUTERMOST column that reaches it, and the ledge quantisation
  // rounds a whole shelf outward. Measured off the fifth pass's own picture
  // rather than off the formula (`shots/sky/2-side.png`, deck 1175 px wide at
  // y230, root at y690), the silhouette at half the drop is **904 px = 77%** of
  // the deck. A bucket, and then a collapse — 988 px to 224 in the last quarter.
  //
  // At 1.55 the same construction reads 0.36 R from the formula and about 0.55
  // of the deck width off the render, which is the number this comment has been
  // quoting from panel 2 for three passes without hitting it. The root, `KEEL`
  // and every flight altitude derived from it are untouched: at d01 = 0 the term
  // is 1 whatever the exponent is.
  const taper = TAPER * Math.pow(Math.max(0, 1 - d01), 1.55);
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
  // ...AND IT ONLY EVER CUTS ON THE OUTER SKIRT. A +1 wobble is a shelf that
  // steps DOWN a ledge, and out past d01 0.55 the skirt is only two or three
  // ledges deep to begin with — so one patch rounding up is worth a third of the
  // remaining taper and puts a lobe of full-depth rock outboard of where the
  // cone has already come in. That is the second half of the bucket the exponent
  // above is the first half of: the profile converged and the wobble kept
  // handing width back. Inside 0.55 it stays two-sided, which is where the
  // shelves are deep enough for a step either way to read as ragged rather than
  // as a bulge.
  const wobble = d01 < 0.25 ? 0 : d01 > 0.55 ? Math.min(0, wob) : wob;
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

/** Scratch for `SkyIsland.debugStructures`. Debug path, but free is free. */
const _dbg = { x: 0, z: 0 };

export class SkyIsland extends CarrierBody implements NpcFrame {
  /** The settlement's public face — name, colour, radius. Its x/z are LIVE. */
  readonly town: SkyTownInfo;
  readonly npcs: Npcs | null;

  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];
  /**
   * The fall off the rim. Null when `water=0`.
   *
   * It owns its own geometry, material and texture and disposes them itself, so
   * it deliberately does NOT go into `geos`/`mats` — those are the rock's.
   */
  private readonly fall: Waterfall | null = null;
  /**
   * The rock mesh, kept only so `debugFall` can report where `buildRock` put
   * it. That number is the regression the waterfall work has to prove it did
   * not cause — see the rebase note at the end of `buildRock`.
   */
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
  /**
   * Where the plan put the wood, LOCAL x/z interleaved. For `debugTrees` and
   * nothing else — the trees themselves are in the merged mesh and their boles
   * are in `solids` with everything else, which is the point of issue #80's fix
   * and also why neither of those can tell a probe which box was a tree.
   */
  private readonly treeSpots: number[] = [];
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
    const plan = planSkyhaven(
      seed, parts, props,
      // The deck's own answer, so the plan and the rock cannot disagree about
      // where the ground stops — `localDeck` is the same function `localTop` feeds
      // the step test from.
      (x, z) => this.localDeck(x, z) > -Infinity,
      (a) => outlineAt(a, this.phase) * CELL,
    );
    this.buildRock(plan);
    for (const t of plan.trees) this.treeSpots.push(t.x, t.z);

    // -- the fall -----------------------------------------------------------
    // Under `flags.water` for the same reason every chunk's surface is: a
    // player who turns water off expects no water anywhere, and this rides that
    // switch rather than earning a settings row of its own for two draw calls.
    if (flags.water) {
      const a = this.fallAnchor(plan);
      this.fall = new Waterfall({
        ...a,
        bearing: plan.fallAngle,
        // FORTY COURSES, in world units — the depth the voxel fall ran to. It
        // ends inside the keel's own depth (which reaches 74-79 courses) and
        // dissolves there rather than stopping square, which is what SPEC §6
        // asks for and what the cubes were tuned to.
        length: 40 * CELL,
        // A LIGHT, STEADY DRIFT. The island cruises at 1 unit/s, so the plume
        // is not being blown by its own passage — this is the prevailing wind
        // at altitude, and it is small because the fall's own wander already
        // breaks up the column. The island's MOTION is a separate term, applied
        // per frame in `update`.
        lateralPush: 2.2,
        swayFromCarrier: true,
      });
      this.root.add(this.fall.group);
    }

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
  localDeck(lx: number, lz: number): number {
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
    const deck = this.localDeck(lx, lz);
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

  /**
   * THE KEEL, in local coordinates: the bottom face of the deepest cube in this
   * column, and +Infinity past the rim.
   *
   * Measured off `columnDepth` — the same function `buildRock` paints from and
   * `paintColumn` tests its neighbours with — so the surface a flyer bumps into
   * is the surface they can see, by construction, the way `localDeck` is the rim
   * they can see. A separate formula for the underside would be the seam this
   * file has already refused twice.
   *
   * A cube at index `-k` spans y in [-k * CELL, (-k + 1) * CELL], so a column
   * `d` courses deep bottoms out at `-d * CELL`. `columnDepth` reports 0 for a
   * LIP column, which is not a hole: the lip is the overhang, three courses of
   * soil and no stone under it (`paintColumn`'s `!stone` branch).
   */
  localBottom(lx: number, lz: number): number {
    if (this.localDeck(lx, lz) === -Infinity) return Infinity;
    const depth = this.columnDepth(Math.floor(lx / CELL), Math.floor(lz / CELL));
    return -(depth > 0 ? depth : LIP_COURSES) * CELL;
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
    if (this.fall) {
      // THE FALL TRAILS BEHIND THE ISLAND. `advance` has already published this
      // slice's step in WORLD x/z; the plume lives in the island's own frame,
      // so the step is rotated in by the same map `toLocal` uses — without the
      // translation, because a delta has no origin.
      //
      // Under `photo=1` `steer` returns early and the step is exactly zero, so
      // a capture gets no lean and needs no special case here.
      const lx = this.dx * this.cy - this.dz * this.sy;
      const lz = this.dx * this.sy + this.dz * this.cy;
      this.fall.update(dt, lx, lz);
    }
  }

  setVisible(v: boolean): void {
    this.root.visible = v;
  }

  /**
   * Show or hide just the fall — the `water` graphics layer, which it rides
   * rather than earning a settings row of its own. See `World.setLayerVisible`.
   */
  setWaterfallVisible(v: boolean): void {
    this.fall?.setVisible(v);
  }

  /** Link the fall's two shader programs at boot. See `warmUpSteps` in main.ts. */
  warmUpWaterfall(render: () => void): void {
    this.fall?.warmUp(render);
  }

  /**
   * The fall's counters, plus the two numbers that say the ROCK did not move
   * when the voxel fall came out of it. For `__dbgSkyFall` and
   * tools/test-waterfall.mjs.
   *
   * `meshOriginY` and `meshMinY * CELL` must be equal — that is the rebase
   * identity `buildRock` documents, stated as a number a probe can compare
   * rather than as prose. `meshMinY` must also still be the KEEL's depth
   * (74-79 courses down), which is what says the fall was never what set it.
   */
  debugFall(): Record<string, number> {
    return {
      meshOriginY: +(this.rock?.position.y ?? NaN).toFixed(5),
      meshMinY: this.rockMinY,
      cell: CELL,
      hasFall: this.fall ? 1 : 0,
      ...(this.fall?.stats() ?? {}),
    };
  }

  /**
   * Append this island's solid boxes to `out`, IN WORLD SPACE, in the same
   * `[cx, cz, hx, hz, yaw, topY]` layout `StructureField.debugBoxes` uses.
   *
   * THE TRANSFORM IS THE WHOLE POINT. Everything the settlement stamped lives
   * in the island's own frame, so handing the debug overlay the field's raw
   * boxes would draw the town's cages wherever the island's origin happens to
   * be relative to the world's — which is nowhere near the island. This is the
   * one place a carrier's contents have to be published in world coordinates,
   * and it is a debug path, so it may allocate and iterate freely.
   *
   * `/show-colliders` showed NOTHING on the island before this: the island's
   * field was simply not in `World.debugStructures`, which asked the towns, the
   * dens and the ground NPCs and knew nothing about a carrier. An overlay that
   * silently omits a whole settlement is worse than one that draws it wrong,
   * because the first reads as "there is no collision here".
   */
  debugStructures(out: number[]): void {
    const local: number[] = [];
    this.solids.debugBoxes(local);
    this.npcs?.solids.debugBoxes(local);
    for (let i = 0; i < local.length; i += 6) {
      this.toWorld(local[i], local[i + 1], _dbg);
      out.push(
        _dbg.x, _dbg.z, local[i + 2], local[i + 3],
        // A local bearing `a` comes out as `a + yaw` under the stamp's own map,
        // which is the same rule `StructureField.add` applies to a ridge.
        local[i + 4] + this.yaw,
        local[i + 5] + this.y,
      );
    }
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
  /**
   * The rim column the fall leaves from, in the island's own frame.
   *
   * Lifted verbatim out of the voxel fall this replaced, so the effect starts
   * on exactly the column the cubes did: one cell INBOARD of the outline,
   * because a fall has to leave a lip you can stand at and look over. Starting
   * it half a cell past the edge — which an earlier pass did — hangs it in the
   * air beside the island like a pipe with nothing at the top of it.
   *
   * Local y is 0, which is the TOP of the turf course and therefore what
   * `localDeck` answers: the water leaves at the surface it has been running
   * along, not at the rim's rock.
   */
  private fallAnchor(plan: SkyPlan): { x: number; y: number; z: number } {
    const rimD = outlineAt(plan.fallAngle, this.phase) - 1;
    const gx0 = Math.round(Math.sin(plan.fallAngle) * rimD);
    const gz0 = Math.round(Math.cos(plan.fallAngle) * rimD);
    // Cell CENTRES, matching how `buildRock` converts a cell to a world column.
    return { x: (gx0 + 0.5) * CELL, y: 0, z: (gz0 + 0.5) * CELL };
  }

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
        const depth = depthAt(keelD01(gx, gz, this.phase), gx, gz);
        // THE LIP: the turf reaches the outline and the stone stops one course
        // short of it, so the grass overhangs all the way round and prints a
        // hard shadow line under itself. Without it the green and the grey read
        // as one mass — see LIP, and `lipAt` for why the setback is ragged.
        const stone = d <= edge - lipAt(gx, gz);
        // THE GREY RIM-STONE COLLAR. `RIM_STONE` cells of the cliff's own rock
        // showing on top all the way round, ragged on its inner boundary the
        // way `lipAt` is ragged on the outer one — hashed at half resolution so
        // a notch is two cells wide and survives being seen from a radius away.
        //
        // A SALT OF ITS OWN, and deliberately not `lipAt`'s 83. Sharing it
        // would make the collar deepen at exactly the columns where the
        // overhang already sets back, i.e. one correlated notch twice as big
        // rather than two independent edges — and the map's two edges are
        // plainly not the same line.
        const rim = d > edge - RIM_STONE
          - (hash2(Math.floor(gx / 2), Math.floor(gz / 2), 89) < 0.35 ? 1 : 0);
        this.paintColumn(
          v, gx, gz, depth, stone,
          // Water first: the map's collar reads 0 at the outflow, because a
          // stream running over the lip has cut through it.
          onStream(wx, wz) ? 'water'
            : rim ? 'rimstone'
              : onPlaza(wx, wz) || onPath(wx, wz) ? 'paved'
                : onPlot(wx, wz) ? 'tilled' : 'turf',
        );
      }
    }

    // THE WATERFALL IS NOT HERE ANY MORE. It was forty courses of opaque cubes
    // baked into this model — see `fallAnchor` and world/waterfall.ts, which
    // replaced them with an animated sheet. The stream that FEEDS it is still
    // painted above (`onStream`): the channel is the island's, the drop is the
    // effect's, and the effect's lip cap covers the seam between them.

    const mesh = v.build(CELL, false);
    // `build` re-bases the model so its LOWEST voxel sits at y = 0, i.e. a cell
    // at `gy` lands at `(gy - minY) * CELL`. The turf is course -1 and its TOP
    // face has to be local 0, which puts the whole model down by `minY * CELL`.
    //
    // THE TWO CANCEL EXACTLY, and that is the point rather than a coincidence:
    // `build` subtracts `minY` and this adds it back, so a cell at `gy` lands
    // at `gy * CELL` for ANY `minY`. It is read off the model only so it is the
    // same `minY` `build` itself used. (An older version of this note claimed
    // the waterfall reached past CLIFF and TAPER and that removing it would
    // move the island. Neither half was true: the keel bottoms out around
    // gy -74 to -79 in `depthAt` and the fall stopped at -40, so it was never
    // the lowest voxel — and even if it had been, the identity above holds.
    // `tools/test-waterfall.mjs` asserts both halves.)
    mesh.position.y = v.bounds(false).minY * CELL;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.name = 'sky:rock';
    this.rock = mesh;
    this.rockMinY = v.bounds(false).minY;
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
    surface: 'turf' | 'paved' | 'tilled' | 'water' | 'rimstone',
  ): void {
    const j = hash2(gx, gz, 7);
    // -- which way this column faces, and therefore how the sun finds it ------
    // The island's centre is the origin, so a column's outward bearing is its
    // own position normalised, and on the cliff and the keel's flanks that IS
    // the surface normal. See `SUN_AZ_X` for why this is baked rather than lit.
    const dlen = Math.max(1e-3, Math.hypot(gx + 0.5, gz + 0.5));
    const facing = ((gx + 0.5) * SUN_AZ_X + (gz + 0.5) * SUN_AZ_Z) / dlen;
    // −1 (dead away) .. +1 (dead into it), mapped onto the two multipliers. This
    // half is the DIRECT term, and it is the half that dies out with depth (see
    // `dir` in the stone loop).
    const sunBase = SUN_AWAY + (facing * 0.5 + 0.5) * (SUN_LIT - SUN_AWAY);
    // ...and this half is the occlusion, which the direct term cannot say and a
    // tint certainly cannot. Down to `SUN_SHADE_K` across the terminator, then
    // back up past it toward `SUN_BOUNCE`, for the reason written at those
    // constants: past the shoulder there is no direct light left to take away
    // and what is there is bounce. It is NOT faded with depth — bounce is the
    // one thing the root has more of than the rim.
    const away = Math.max(0, -facing);
    const sunShade = away <= SUN_KNEE
      ? 1 - (1 - SUN_SHADE_K) * (away / SUN_KNEE)
      : SUN_SHADE_K + (SUN_BOUNCE - SUN_SHADE_K) * ((away - SUN_KNEE) / (1 - SUN_KNEE));
    const sunTint = facing >= 0 ? ROCK_WARM : ROCK_COOL;
    // THE COOL TINT PEAKS AT THE TERMINATOR AND IS GONE BY THE BACK, which is
    // the same knee `sunShade` turns on and for the same reason read the other
    // way round. A face in full shade is lit by SKYLIGHT, and the renderer's
    // ambient is already sky-coloured — so a cool albedo on top of it is the one
    // place this file's hue walk double-counts. Measured at a flat 0.45 mix the
    // back cliff came back **(22, 44, 68)**, R−B **−46**: navy, not stone,
    // against a reference back cliff (`ref-angles.png` panel 3) of +15. The
    // WARM half needs no such treatment — it is on the side the sun reaches, so
    // nothing else is supplying its colour.
    const coolFall = away <= SUN_KNEE
      ? away / SUN_KNEE
      : Math.max(0, 1 - (away - SUN_KNEE) / (1 - SUN_KNEE));
    const sunMix = facing >= 0 ? facing * SUN_WARM_MIX : coolFall * SUN_COOL_MIX;
    // -- the surface course ---------------------------------------------------
    // FOUR GROUND MATERIALS, because the reference's plateau is not a lawn: it
    // is flagstone in the square and the streets, tilled rows in the gardens,
    // water in the channel, and turf in between. One of these per column is the
    // whole of the ground dressing and it costs nothing.
    let topC: number;
    if (surface === 'water') topC = shade(j < 0.4 ? WATER_L : WATER, 0.94 + j * 0.16);
    // THE COLLAR IS THE CLIFF, SEEN END-ON, so it is the cliff's own two light
    // stops and the cliff's own sun term — not a fifth ground material. Its top
    // face gets the +Y face shade of 1.00 against 0.88 on the sheer band below
    // it, which is what makes the same albedo read as a lit stone kerb from
    // above and as dark rock from the side. See `RIM_STONE`.
    // ...WITH ONE EXCEPTION, AND IT IS THE COLLAR'S OWN TOP FACE. See `RIM_TOP`:
    // a +Y face has the same relationship to the sun on every bearing, so it
    // takes neither the flank's value walk (`sunK`) nor its hue walk — a token
    // 0.15 of the tint is left so the ring is not the one surface on the island
    // with no bearing in it at all. What is left is the per-cell jitter, which
    // is what keeps the ragged edge from reading as a painted stripe.
    else if (surface === 'rimstone') {
      topC = tintTo(shade(RIM_TOP, 0.92 + j * 0.18), sunTint, sunMix * 0.15);
    }
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
    // ...EXCEPT UNDER THE COLLAR, where it is stone too. A brown course between
    // a grey kerb and the grey cliff it is the top of would draw a line across
    // the one place the rock is meant to read as continuous, and in profile it
    // is the map's own answer: the collar is the top of the cliff, so there is
    // no soil in it. The dirt line still runs everywhere the turf reaches the
    // edge, which is every bearing the collar is notched back on.
    v.set(gx, -2, gz, surface === 'rimstone'
      ? tintTo(shade(STONE_D, (0.92 + j * 0.2) * sunBase * sunShade), sunTint, sunMix)
      : shade(j < 0.5 ? DIRT : DIRT_D, 0.92 + j * 0.2));
    if (!stone) {
      // An overhanging lip is soil all the way down its two courses; giving it
      // a third of stone would put grey under the grass at the one place the
      // dirt line is meant to read.
      v.set(gx, -3, gz, surface === 'rimstone'
        ? tintTo(shade(STONE_D, (0.9 + j * 0.2) * sunBase * sunShade), sunTint, sunMix)
        : shade(DIRT_D, 0.9 + j * 0.2));
      return;
    }

    // -- the stone, shell only ------------------------------------------------
    // A cell is painted when a face of it can be seen: near the top, at the
    // bottom of its own column, or where a neighbour is shallower.
    const nb = [
      this.columnDepth(gx + 1, gz), this.columnDepth(gx - 1, gz),
      this.columnDepth(gx, gz + 1), this.columnDepth(gx, gz - 1),
    ];
    // THE STRATA ARE HORIZONTAL, AND THEY WERE VERTICAL. This is the single
    // worst thing the second pass shipped and it is worth being precise about
    // the cause, because the code that produced it looks correct. The ramp was
    // keyed on `t = (k - 3) / (depth - 3)` — the course's depth as a fraction of
    // ITS OWN COLUMN's depth — so two neighbouring columns of different depth
    // were at different `t` at the same `k` and therefore in different colour
    // bands and at different values. Since `depthAt`'s ledge wobble makes
    // neighbouring depths differ by whole shelves, the result was a keel painted
    // in one-cell-wide VERTICAL stripes of alternating hue, running the full
    // drop: corduroy (`shots/sky/5-underside.png`, second pass) on a surface
    // whose whole subject is stratification.
    //
    // Keyed on ABSOLUTE depth the bands are level courses that run round the
    // island and across every shelf, which is what stratified stone is and what
    // panels 2 and 5 of the reference sheet show. `MAXD` is the total drop, so a
    // band boundary is at the same world height everywhere.
    const MAXD = CLIFF + TAPER;
    // ...but not DEAD level, or the island wears four perfect contour rings.
    // A slow hash at 9 cells shifts the boundaries by up to three courses, so a
    // stratum dips and rises the way a real bed does. Coarse for the same reason
    // `depthAt`'s wobble is: at cell resolution this is per-column noise again,
    // which is the defect it exists to avoid.
    const bed = (hash2(Math.floor(gx / 9), Math.floor(gz / 9), 23) - 0.5) * 6;
    for (let k = 3; k <= depth; k++) {
      const bottom = k === depth;
      // Whether any SIDE face of this cell is open, which is a different
      // question from whether the cell is painted at all and the one the
      // soffit lift below turns on.
      const sideOpen = nb.some((n) => n < k);
      const exposed = bottom || k <= 4 || sideOpen;
      if (!exposed) continue;
      const u = Math.min(1, Math.max(0, (k + bed - 3) / (MAXD - 3)));
      // FOUR STOPS, and the first of them is the whole sheer band: `CLIFF` is
      // 16 of 74 courses, i.e. u < 0.18, which is why the light stop reaches
      // that far. The rim collar and the top of the cliff are one material in
      // the art and they are one here.
      // A CELL THAT CAN ONLY EVER BE SEEN AS ITS SOFFIT GETS ITS OWN STONE,
      // rather than a multiplier on one of the four. See `STONE_SOFFIT`.
      const band = u > 0.72 ? STONE_ROOT : u > 0.46 ? STONE_DEEP : u > 0.20 ? STONE_D : STONE;
      // EVERY BOTTOM CELL IS A SOFFIT; ONLY SOME OF THEM ARE NOTHING ELSE. That
      // distinction is the one lever in this file that moves `5-underside.png`
      // WITHOUT moving `2-side.png`, and finding it is what the fifth pass's
      // 2.3:1 stalemate was missing. A −Y face is visible only from beneath, and
      // the side capture sits at the deck less ten units looking DOWN — so it
      // never sees one, while the underside capture is made of them. The
      // buried-on-every-side case already had its own albedo; the case with an
      // open side face had a bare 1.15 multiplier on the band colour, which is
      // the same rock and therefore the same black from below.
      //
      // 0.45 rather than the whole way, because that cell shows a side face TOO
      // and the side face is in the light. It is the one voxel in the model that
      // has to answer two cameras at once, so it answers each of them half.
      const c = !bottom ? band
        : sideOpen ? tintTo(band, STONE_SOFFIT, 0.45) : STONE_SOFFIT;
      const jj = hash2(gx, gz - k * 31, 13);
      // The TOP face of a ledge is what catches the sky, so a course whose
      // neighbour is two shallower, a shelf rather than a wall, is lifted
      // rather than darkened.
      // 1.08 rather than 1.14: a shelf's top face already gets the +Y face shade
      // of 1.0 against 0.62 on the down-face it sits over, so the lift is
      // stacking on a 60% contrast that is already there. At 1.14 the lit
      // shelves came back as tan flashes on a near-black mass — the two things
      // in the frame furthest apart in value, on a surface that should read as
      // one rock in two lights.
      //
      // 1.34, AND IT REACHES TWO COURSES RATHER THAN ONE. The tan-flash failure
      // the paragraph above is written against was measured on a keel whose deep
      // stops were 0x4a5450 — a third darker than they are now — so "the two
      // things in the frame furthest apart in value" was as much a statement
      // about the field as about the lift. What the fifth pass shipped instead
      // is a keel with no strata at all: the highlight ceiling across the whole
      // cliff band of `2-side.png` (x300-1000 y250-400) is p95 **86**, and the
      // deepest terraced band only reaches 131, against 111-117 on reference
      // panel 2 and 115 on panel 5's own rock. The shelf tops — the faces that
      // are the entire reason `LEDGE` exists — are indistinguishable from the
      // risers under them.
      //
      // `drop` is how far below the shelf's own lip a cell sits: 1 at the lip,
      // `LEDGE` at the foot of the riser. The lip catches the sky, the course
      // under it catches most of what the lip bounces, and the rest of the riser
      // is a wall — which is three values rather than the two a boolean can say,
      // and is why widening the old test from `< k − 1` to `< k − 2` would have
      // lifted FOUR of the five courses and simply moved the median.
      const drop = k - Math.min(nb[0], nb[1], nb[2], nb[3]);
      const shelf = !sideOpen ? 1 : drop <= 1 ? 1.26 : drop <= 2 ? 1.12 : 1;
      // THE FLANK WALK IS A CLIFF TERM AND IT DIES OUT WITH DEPTH. `sunBase` is a
      // statement about which way a VERTICAL WALL points relative to a sun 38
      // degrees up, which is exactly true of the sheer band and progressively
      // less true the further down the keel it is applied: down there the rock
      // is a lattice of shelves under an open sky, its dominant source is bounce
      // from every direction at once, and the renderer has ALREADY taken the
      // direct term out of every face that points away. Left at full strength
      // the bake was subtracting a second time from the one surface in the
      // frame that could least afford it — measured, the away half of
      // `5-underside.png` is where its p25 of 24 lives.
      //
      // So it fades to 15% of itself at the root. Note what this is NOT: it is
      // not a brightening, it is the removal of a directional claim at the depth
      // where the claim stops being true, and it takes the same 13% back off the
      // LIT half of the root that it puts on the shaded one.
      const dir = (1 + (sunBase - 1) * (1 - 0.85 * u)) * sunShade;
      // ...AND THE UNDERSIDE OF A SHELF IS LIFTED HARDER THAN ANYTHING ELSE IS,
      // which is the one place this file gets to answer the renderer back. A
      // down-face is multiplied by 0.62 (core/voxel.ts) AND is the one
      // orientation the sun never reaches, so it is lit by ambient alone —
      // measured against a sunlit side face at 0.88 that is better than five
      // stops, and the keel came back as tan flashes on black at every albedo
      // tried. There is no per-face hook, but there is a proxy that costs
      // nothing: the bottom voxel of a column is exactly the cell whose −Y face
      // is the shelf soffit, and its own side faces are buried in its
      // neighbours except at the shelf's outer edge.
      //
      // WHAT IS LEFT OF THE LIFT after `STONE_SOFFIT` took over the job — a
      // token 1.15 on the OTHER kind of bottom cell, the one at a shelf's outer
      // edge whose side face is the riser. It is already in the light, so it
      // wants a nudge rather than a stop; the read this file spent three passes
      // chasing lives in the soffit albedo now, where it does not clip and does
      // not spill onto a sunlit face. See `STONE_SOFFIT` for the measurements.
      // ...and the 1.15 that used to be here is GONE: the tint above says the
      // same thing in the one axis that reaches a −Y face, and a multiplier on
      // top of it would be a third darkening-and-lifting of the one voxel that
      // is already compromising between two cameras.
      const under = 1;
      // COURSING, in the sheer band only, and WIDENED from ±0.90/1.06 to
      // 0.84/1.11 in the same pass that took the stone down 35% in value: the
      // rhythm was tuned against a cliff at median luma 90 and at 65 the same
      // percentages are fewer code values, so the band flattened out as it
      // darkened. `ref-hero.png` draws this coursing hard.
      // A cliff face with no horizontal rhythm
      // in it is a wall of noise however well the strata are keyed, and the art
      // draws visible block courses on exactly the part of the rock that is
      // sheer enough to show them — below the band the shelves' own lips do the
      // job and a second rhythm on top of them reads as stripes.
      const course = u < 0.30 ? (k % 4 === 0 ? 0.76 : k % 4 === 2 ? 1.18 : 1) : 1;
      // 0.32 rather than the 0.45 the first version of this ramp used: at 45%
      // the root went to near-black and lost its own terracing along with its
      // form, which trades one flat surface for a darker one.
      // 0.12, not the 0.32 this had: the ramp is stacking on a face the sun
      // already does not reach, and at a third the keel went to a silhouette
      // with no terracing visible in it at all.
      // THE RAMP RUNS THE OTHER WAY NOW — see `DEPTH_LIFT`.
      // THE JITTER IS THE OTHER HALF OF THE FLAT-FLANK FIX, and it is cheaper
      // than it looks. ±0.11 about 0.99 is a spread of a couple of code values
      // at these albedos, which is why the fifth pass's shaded flank measured a
      // NINE-value interquartile over an area 340 px across — one surface, one
      // value. ±0.21 about 0.99 (0.78 + jj * 0.42) doubles the texture without
      // moving the mean, so the flank gets grain rather than gets lighter, and
      // the reference's own 22-50 interquartiles come within reach.
      v.set(gx, -k, gz, tintTo(
        shade(c, (0.66 + jj * 0.70) * (1 + DEPTH_LIFT * u) * shelf * course * under * dir),
        sunTint, sunMix,
      ));
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
    //
    // 0.28 and 2-7 courses, up from 0.20 and 2-4. The accent held at 20% but the
    // strands were all the same short length, which made them read as a dotted
    // line under the turf rather than as ivy: in the painting a few hang nearly
    // the whole sheer band while most give out in a course or two, and it is the
    // RANGE that says something is growing. Capped at `CLIFF` so nothing hangs
    // past the sheer band onto the shelves — the art's keel is bare rock, and
    // green on the terraces reads as spilt grass.
    //
    // ...AND IT WAS STILL A DOTTED SEAM, because the RANGE the paragraph above
    // asks for is not what `** 2 * 6` gives. Measured, coverage was already
    // right — 4.56% of the sheer band in `2-side.png` against 5.25% in
    // reference panel 2 — but the longest strand the formula can produce is 7
    // courses of a `CLIFF` of 16, i.e. 44% of the band at the absolute maximum,
    // and the squared hash puts nearly all of them at 2-3. Every strand between
    // x430 and x1150 terminated within 60 px of the turf line. `ref-hero.png`
    // has strands descending 170 px of a 400 px band and several running its
    // full height, and that is the whole reason ivy reads as growing.
    //
    // `* 15` keeps the squared hash — which is what holds the MEDIAN at 2-3, so
    // the accent is unchanged — and opens the tail to 14-16, i.e. the full
    // sheer band on the handful of columns that roll near 1. The 0.28 rate is
    // untouched; it was never the coverage that was wrong.
    if (nb.some((n) => n === 0) && hash2(gx, gz, 53) < 0.28) {
      const len = 2 + Math.floor(hash2(gx, gz, 59) ** 2 * 15);
      for (let k = 3; k < 3 + len && k <= Math.min(depth, CLIFF); k++) {
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
    if (d > edge - lipAt(gx, gz)) return 0;
    return depthAt(keelD01(gx, gz, this.phase), gx, gz);
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
  // The trees go through the same stamp as everything else, and the stamp
  // blocks them: a tree template carries no `solid` but it does carry the
  // `trunk` its own bake measured, and `StructureField.add` makes a bole out of
  // that (`boleBox`, world/structures.ts). The overworld's canopies block off
  // the same measurement through the chunk trunk registry — the island has no
  // chunk, which is why it needed the second consumer rather than a second
  // number. Issue #80: you walked through every trunk on the deck.
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
