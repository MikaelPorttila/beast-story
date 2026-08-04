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
 * WHAT IS AND IS NOT IN THIS FILE, since the island is three things at once:
 *
 *   the ROCK      a procedural mesh, not a voxel model. A voxel island at the
 *                 town's own 0.28 scale would be 385 cells across and 148k
 *                 columns before a single hut was placed, and every one of them
 *                 would be interior. The shape wanted here is a smooth dome
 *                 over a rocky keel, which is a radial grid — 64 sectors by 22
 *                 rings, built once, ~2.8k triangles, never rebuilt.
 *   the DECK      one function, `deckAt`, and it is the authority twice over:
 *                 the mesh's top surface is sampled from it, and `localTop`
 *                 answers every step test from it. There is no second formula
 *                 for the ground you stand on, which is the same rule the road
 *                 ribbon obeys for the same reason (world/town-parts.ts) — what
 *                 you see is what you stand on BY CONSTRUCTION, not because two
 *                 functions currently agree.
 *   the TOWN      built with `TownParts` and `SolidStamp` exactly as a ground
 *                 settlement is, in the island's own local coordinates. It has
 *                 no roads, no flatten disc and no yard, because the deck is
 *                 already level ground that nothing else is competing for.
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
import { Accum, PropLib } from './props';
import { SolidStamp, StructureField } from './structures';
import { TownParts } from './town-parts';
import { Npcs, type NpcFrame, type NpcSite } from './npc';
import type { RoadClearance } from './roads';
import { mulberry32 } from './noise';
import { CARRIED_LAYOUT_KIND, content, defineFactory, type TownData } from '../content';
import { displayKey, reportContentIssue } from '../core/content-bridge';
import type { Terrain } from './terrain';
import { WATER_LEVEL } from './terrain';

// ---------------------------------------------------------------------------
// Size
// ---------------------------------------------------------------------------

/**
 * The island's footprint radius, in world units.
 *
 * The issue asks for "8 times the size of the encampment", and the Encampment's
 * footprint radius is 19 (`town:encampment` in core.json). EIGHT TIMES THE AREA
 * rather than eight times the radius, which is the reading that produces an
 * island: `19 * sqrt(8)` is 53.7, so the thing is 107 units across, and the
 * streamed view radius is 160 — you can stand on the ground and see the whole
 * of it against the sky, which is what makes it read as a floating landmass.
 * Eight times the RADIUS is 304 across, wider than the world is drawn, and from
 * underneath it stops being an island and becomes a ceiling.
 *
 * Everything else here is a fraction of this number, so it is one edit.
 */
export const ISLAND_R = 19 * Math.SQRT2 * 2;

/**
 * How far the centre of the deck stands above its rim, in world units.
 *
 * A dome and not a table, so the island has a horizon of its own and the town
 * is not visible edge-to-edge from the moment you land. 5 units over 53.7 is a
 * 5.3-degree average slope, which is nothing to walk and everything to look at;
 * the local gradient never approaches `MAX_STEP_UP` over a body's stride, which
 * is the constraint that actually binds (see `deckAt`).
 */
const DOME = 5.2;

/**
 * How far the keel hangs below the rim, in world units.
 *
 * The whole reason an island reads as torn out of the ground rather than as a
 * disc: seen from underneath it is a root of rock, and seen from the side it is
 * the deep half of the silhouette. It is also the number the altitude rule
 * clears the mountains by — see `KEEL_MARGIN`.
 */
const KEEL = 27;

/**
 * How far the keel's lobes swing its depth, as a fraction. See `keelAt`.
 *
 * 0.22 is enough that the root reads as several roughly-conical masses fused
 * together rather than as one turned shape, and small enough that the deepest
 * lobe is still clearly part of the same island as the shallowest. It is also
 * what `KEEL_MARGIN` has to cover on top of `KEEL`, which is why the margin is
 * measured from the nominal depth rather than the worst one.
 */
const KEEL_LOBE = 0.22;

/** Where the grass gives out and the rim rock starts, as a fraction of R. */
const GRASS_EDGE = 0.86;

// ---------------------------------------------------------------------------
// Flight
// ---------------------------------------------------------------------------

/**
 * How far from home the island wanders, in world units.
 *
 * "Flying around random within a large radius of the spawn location of the
 * town", and 240 is what makes that a journey rather than a lap: at the cruise
 * below, crossing the roam disc takes about three minutes, so the island is
 * somewhere different every time the player looks up and never so far that it
 * has left the part of the map the rest of the game is in.
 */
const ROAM_R = 240;
/**
 * Cruise speed, world units/second.
 *
 * 2.4 is slower than the hero walks (4.2) and slower than a galebird flies, so
 * the island can always be caught, and it is fast enough that the ground
 * visibly moves underneath while you stand on the deck — which is the whole
 * point of the thing and the only way a player finds out it is moving at all.
 */
const CRUISE = 2.4;
/** How hard it accelerates onto a new heading; the lambda of an exponential. */
const TURN_LAMBDA = 0.22;
/** How fast the hull's own heading follows its travel, radians/second. */
const YAW_RATE = 0.045;
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
const MIN_ALT = 78;
/** ...and never higher, so it stays under the cumulus deck's own 80-142 band. */
const MAX_ALT = 104;
/** How fast it may climb or sink, world units/second. */
const CLIMB_RATE = 3.0;

/**
 * How far AHEAD of itself the island looks, as a multiple of its own radius.
 *
 * At `CRUISE` and `CLIMB_RATE` the island needs 4.7 seconds to gain the 14
 * units of a full margin, in which it travels 11 units. Looking one radius
 * ahead of its own rim gives it 22 — twice what the worst case needs, which is
 * the right size of margin for a number sampled at a dozen points.
 */
const LOOK_AHEAD = 2;

// ---------------------------------------------------------------------------
// The town on it
// ---------------------------------------------------------------------------

/**
 * What a CARRIED town's layout is handed: a stamp that draws and blocks in one
 * call, an accumulator for anything that glows, the parts bin, and the deck it
 * is standing on.
 *
 * EVERY COORDINATE HERE IS LOCAL — the island's own frame, origin at its centre
 * — which is what lets a layout be written exactly like a ground one while the
 * whole settlement is a thousand units away and moving. Compare `TownLayout` in
 * world/towns.ts: the difference is that this one is handed a `deckAt` instead
 * of a road network and a height field, because a deck has no roads and its
 * ground is a closed-form function rather than a streamed field.
 *
 * Returns the settlement's FOCUS — its fire — in local coordinates, or null.
 * Same contract as a ground layout, and for the same consumer: `NpcSite.focusOf`
 * is how a character asks to stand across the fire from wherever else he might
 * have gone.
 */
export type CarriedLayout = (
  solid: SolidStamp,
  glow: Accum,
  parts: TownParts,
  radius: number,
  deckAt: (x: number, z: number) => number,
  rng: () => number,
) => { x: number; z: number } | null;

/**
 * Skyhaven's own layout: a fire in the middle, dwellings on a ring around it,
 * working clutter between them and lamps out toward the rim.
 *
 * It is deliberately NOT the Encampment's plan with the wall taken off. A camp
 * is defensive and faces inward against a palisade; an island has a horizon on
 * every bearing and nothing to defend against, so the buildings sit back from
 * the middle and leave the view open, and what stands at the edge is a lamp
 * rather than a stake.
 *
 * THERE IS NO PERIMETER, and that is a decision rather than an omission. A rail
 * around the rim would make the one thing this place has that nowhere else does
 * — an edge you can walk off — into scenery you bump into. The lamps mark it;
 * they do not fence it.
 */
const buildSkyhaven: CarriedLayout = (solid, glow, parts, radius, deckAt, rng) => {
  const at = (a: number, d: number): [number, number] => [Math.sin(a) * d, Math.cos(a) * d];

  // -- the fire, a little off centre so the plaza is not a bullseye ---------
  const fireA = rng() * Math.PI * 2;
  const [fx, fz] = at(fireA, radius * 0.06);
  solid.add(parts.fire, fx, deckAt(fx, fz), fz, rng() * 6.28);
  // The flame is a SEPARATE model on a separate material, so `GLOW_PART` in
  // town-parts.ts parts its face grid from the logs' — see the z-fighting note
  // in AGENTS.md, and `bakeAt`, which every glow piece already passes through.
  glow.add(parts.fireGlow, fx, deckAt(fx, fz), fz, rng() * 6.28, 1, 1, 1, 1);

  // -- dwellings, on a ring ------------------------------------------------
  // Eight bearings, six of them built, so the ring has gaps you walk out
  // through instead of being a wall of huts with a door in it.
  const ringD = radius * 0.42;
  const skip = Math.floor(rng() * 8);
  for (let k = 0; k < 8; k++) {
    if (k === skip || k === (skip + 4) % 8) continue;
    const a = (k / 8) * Math.PI * 2 + fireA * 0.13;
    const [x, z] = at(a, ringD + (rng() - 0.5) * radius * 0.1);
    // Facing the fire: a dwelling's door is the side you approach from, and on
    // an island the thing everyone approaches from is the middle.
    const yaw = a + Math.PI;
    const t = k % 3 === 2 ? parts.tents[k % parts.tents.length] : parts.huts[k % parts.huts.length];
    solid.add(t, x, deckAt(x, z), z, yaw);
  }

  // -- the well, and the working clutter -----------------------------------
  {
    const [x, z] = at(fireA + 2.3, radius * 0.25);
    solid.add(parts.well, x, deckAt(x, z), z, rng() * 6.28);
  }
  const clutter = [parts.barrel, parts.crateS, parts.crateL, parts.woodpile, parts.rack, parts.cartOpen];
  for (let k = 0; k < clutter.length; k++) {
    const a = rng() * Math.PI * 2;
    const d = radius * (0.16 + rng() * 0.34);
    const [x, z] = at(a, d);
    solid.add(clutter[k], x, deckAt(x, z), z, rng() * 6.28);
  }

  // -- lamps toward the rim ------------------------------------------------
  // Out at 0.78 of the radius, which is inside `GRASS_EDGE` (0.86): a lamp
  // stands on grass and the last of the deck beyond it is bare, so the edge
  // reads as an edge and the lamps read as the last thing before it.
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + 0.4;
    const [x, z] = at(a, radius * 0.78);
    const y = deckAt(x, z);
    solid.add(parts.lamp, x, y, z, a + Math.PI);
    glow.add(parts.lampGlow, x, y, z, a + Math.PI, 1, 1, 1, 1);
  }

  return { x: fx, z: fz };
};

/** The carried layouts this build implements. See `TownData.carried`. */
const CARRIED_LAYOUTS: Readonly<Record<string, CarriedLayout>> = {
  skyhaven: buildSkyhaven,
};

for (const [name, fn] of Object.entries(CARRIED_LAYOUTS)) {
  defineFactory(CARRIED_LAYOUT_KIND, name, fn);
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

const s2l = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
/** sRGB hex -> the linear triple a vertex-coloured standard material wants. */
const lin = (hex: number): [number, number, number] => [
  s2l(((hex >> 16) & 255) / 255), s2l(((hex >> 8) & 255) / 255), s2l((hex & 255) / 255),
];

const GRASS = lin(0x6f9a4a);
const GRASS_D = lin(0x577c3a);
const ROCK = lin(0x8a8175);
const ROCK_D = lin(0x7a7167);
/**
 * The deep rock at the point of the keel. Lighter than it looks like it should
 * be, and deliberately: it is the least-lit surface in the world (see
 * `wrapKeelNormals`), so a colour picked to look like deep shade in isolation
 * lands on top of geometry that is already shaded and comes out black.
 */
const KEEL_C = lin(0x6a5f54);

/**
 * How far a keel normal is bent toward its outward radial, and how much +Y is
 * added afterwards. See `wrapKeelNormals`.
 *
 * 0.72 is enough that the sun-facing flank of the root is plainly lit while the
 * shaded side stays dark, so the island still has a lit side and a shadow side
 * rather than being uniformly bright; the +Y term is what keeps the very bottom
 * from falling back to black as the radial goes horizontal.
 */
const WRAP = 0.72;
const WRAP_UP = 0.34;

// ---------------------------------------------------------------------------

/** Radial mesh resolution. 64 sectors is 5.6 degrees; the rim reads as round. */
const SECTORS = 64;
/** Rings across the deck, and down the keel. */
const TOP_RINGS = 18;
const KEEL_RINGS = 9;

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

  constructor(
    private readonly terrain: Terrain,
    props: PropLib,
    parts: TownParts,
    data: SkyTownData,
    /** Where it wanders around, world x/z. */
    private readonly homeX: number,
    private readonly homeZ: number,
    seed: number,
  ) {
    super(`carrier:town:${data.id}`, ISLAND_R);
    this.rng = mulberry32(seed ^ 0x51a7);
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
      carried: true,
      // No keep-out. It is not that the town does not deserve one — it is that
      // a spawn rule is a disc on the GROUND (see SafeZone), and this town is
      // not on the ground: nothing can spawn on the deck in the first place,
      // because every spawn path resolves its candidate against `getHeight`.
      noSpawnRadius: 0,
    };

    this.buildRock();

    // -- the settlement, in local coordinates -------------------------------
    const stamp = new SolidStamp(this.solids);
    const glow = new Accum();
    const layout = content.factory<CarriedLayout>(CARRIED_LAYOUT_KIND, data.layout);
    const fire = layout?.(
      stamp, glow, parts, ISLAND_R, (x, z) => this.deckAt(x, z), this.rng,
    ) ?? null;
    this.solids.build();
    this.emit(stamp.acc, props.solidMat, true, false);
    // The same glow material every settlement's fires and lamps use — a
    // vertex-coloured standard material with a warm emissive, which is what
    // makes the selective bloom pass pick them up. Its own, because the island
    // outlives no `Towns` instance it could borrow one from.
    this.emit(glow, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.6, metalness: 0,
      emissive: new THREE.Color(0xff9a3c), emissiveIntensity: 2.0,
    }), false, true);

    // -- the people ---------------------------------------------------------
    // Every query in the site is in the island's frame, so the placement search
    // walks rings around the island's own origin and tests the island's own
    // deck. `this` is the frame: `Npcs` transforms its records to world space
    // once a slice so that the talk test, which is asked in world space by
    // main.ts, keeps working with no branch in it.
    const site: NpcSite = {
      towns: localRegistry({ ...this.town, x: 0, z: 0, gateX: 0, gateZ: 0 }),
      roads: NO_ROADS,
      getHeight: (x, z) => this.deckAt(x, z),
      structureTopAt: (x, z) => this.solids.topAt(x, z),
      focusOf: () => fire,
    };
    const crew = new Npcs(site, this);
    this.npcs = crew.all.length > 0 ? crew : null;
    if (this.npcs) this.root.add(crew.group);
    else crew.dispose();
  }

  // -- the shape ------------------------------------------------------------

  /**
   * THE WALKING SURFACE, in local coordinates: local y of the deck at (lx, lz),
   * or -Infinity past the rim.
   *
   * ONE FUNCTION, TWO CONSUMERS — the mesh samples it for every vertex of its
   * top surface, and `localTop` answers every step test with it. That is the
   * road ribbon's rule (world/town-parts.ts) applied to a second surface, and
   * for the identical reason: two formulas that agree today are two formulas,
   * and the failure mode is a hero standing exactly where the physics puts him
   * and buried to the chest.
   *
   * THE UNDULATION IS SINES, not noise, and it is bounded on purpose. The two
   * terms peak at a combined gradient of 1.1*0.11 + 0.6*0.19 = 0.235 per unit,
   * so the deck rises at most 0.12 across the hero's 0.5-unit probe against a
   * `MAX_STEP_UP` of 0.5 — the surface can never present him with a step, which
   * a noise field would have to be measured to promise.
   */
  deckAt(lx: number, lz: number): number {
    const d = Math.hypot(lx, lz) / ISLAND_R;
    if (d >= 1) return -Infinity;
    const dome = DOME * (1 - d * d);
    const roll = 1.1 * Math.sin(lx * 0.11 + 1.7) * Math.cos(lz * 0.09 - 0.6)
      + 0.6 * Math.sin(lz * 0.19 + 2.2) * Math.cos(lx * 0.17);
    // The undulation fades out at the rim so the edge is a clean circle: a
    // wobbling rim reads as a modelling mistake at the one place the silhouette
    // is against the sky.
    return dome + roll * Math.max(0, 1 - d * 1.35);
  }

  /**
   * How far below local 0 the keel hangs at a point on the underside.
   *
   * THE LOBES ARE THE WHOLE POINT. A pure function of the radius is a bowl, and
   * a bowl reads as a saucer rather than as something that was torn out of the
   * ground — the silhouette is the only thing about the underside a player ever
   * sees clearly, since it is the half of the island that is always against the
   * sky. Two sine terms at 7 and 4 lobes give it a ragged profile that changes
   * as you fly around it, and they are scaled by `1 - d` so the rim stays a
   * clean circle where it meets the deck.
   */
  private keelAt(lx: number, lz: number): number {
    const d = Math.min(1, Math.hypot(lx, lz) / ISLAND_R);
    const base = -KEEL * Math.pow(Math.max(0, 1 - d * d), 0.62);
    const a = Math.atan2(lx, lz);
    const lobe = Math.sin(a * 7 + 1.3) * 0.5 + Math.sin(a * 4 - 0.7) * 0.32;
    return base * (1 + KEEL_LOBE * lobe * (1 - d));
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
   * library and is disposed with it; the glow material is made here. Getting
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
   * Bend the keel's normals OUTWARD, from `first` to the end of the buffer.
   *
   * THE UNDERSIDE OF A FLOATING ISLAND IS THE ONE SURFACE IN THIS GAME THAT
   * FACES AWAY FROM EVERY LIGHT IN THE SCENE. There is one directional sun and
   * a hemisphere fill whose ground colour is nearly black, so a true-normal
   * keel renders as a black disc — captured in _sky-b.png, where a hundred
   * units of rock read as a hole cut in the sky. Nothing else in the world has
   * the problem: terrain undersides are never seen, a hut's floor sits on the
   * ground, and a cumulus repaints its own belly for exactly this reason (see
   * pass 5 in world/clouds.ts).
   *
   * So the keel is lit as a CLIFF rather than as a ceiling: each normal is bent
   * toward its own outward radial, which is the direction the rock visibly
   * falls away in, plus a little up. It is a lighting cheat and it is the same
   * one every stylised renderer uses on foliage — the surface reads as a lit
   * mass with a shaded belly instead of a silhouette, and the alternative is a
   * second light source pointing up out of the ground.
   *
   * `first` is the index of the first keel vertex. The deck's normals are
   * untouched: grass under a sun is exactly what `computeVertexNormals` is for.
   */
  private wrapKeelNormals(geo: THREE.BufferGeometry, first: number): void {
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
    for (let i = first; i < pos.count; i++) {
      const lx = pos.getX(i);
      const lz = pos.getZ(i);
      const d = Math.hypot(lx, lz);
      // The point of the keel has no outward direction; leave it alone rather
      // than dividing by nothing. It is one vertex and it is the deepest, most
      // shaded place on the model anyway.
      if (d < 1e-3) continue;
      const k = WRAP;
      let nx = nrm.getX(i) * (1 - k) + (lx / d) * k;
      let ny = nrm.getY(i) * (1 - k) + WRAP_UP;
      let nz = nrm.getZ(i) * (1 - k) + (lz / d) * k;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      nrm.setXYZ(i, nx, ny, nz);
    }
    nrm.needsUpdate = true;
  }

  /**
   * The rock: a radial deck on top and a radial keel underneath.
   *
   * TWO MESHES, NOT ONE, AND THE REASON IS THE SHADOW MAP. They were one — the
   * two surfaces share a rim ring, and a seam at the one place the silhouette
   * is against open sky is exactly the sort of hairline crack that only shows
   * up in a screenshot. But a mesh that both casts and receives shadows
   * SHADOWS ITSELF, and this particular mesh is a hundred-unit lid directly
   * over its own underside: the keel came out uniformly black whatever its
   * normals or its colours said, because it was in the deck's shadow. Captured
   * in _sky-c.png, where the island's root reads as a hole cut in the sky.
   *
   * So the deck receives (the huts' shadows fall across the grass, which is
   * most of what tells you the town is standing on something) and the keel does
   * not (there is nothing above it but the deck, and its shadow is the whole
   * problem). The rim ring is emitted into BOTH, from the same `pushRing` at
   * the same `d`, so the two share vertex positions exactly and there is no
   * crack to see.
   */
  private buildRock(): void {
    /** One surface under construction. See `flush`. */
    let pos: number[] = [];
    let nrm: number[] = [];
    let col: number[] = [];
    let idx: number[] = [];
    let rings: number[] = [];

    const pushRing = (
      d: number, yOf: (lx: number, lz: number) => number, colOf: (d: number, j: number) => readonly number[],
    ): void => {
      rings.push(pos.length / 3);
      const r = d * ISLAND_R;
      const n = d === 0 ? 1 : SECTORS;
      for (let j = 0; j < n; j++) {
        const a = (j / SECTORS) * Math.PI * 2;
        const lx = Math.sin(a) * r;
        const lz = Math.cos(a) * r;
        pos.push(lx, yOf(lx, lz), lz);
        nrm.push(0, 0, 0);
        const c = colOf(d, j);
        col.push(c[0], c[1], c[2]);
      }
      // A ring of one vertex (the pole) is repeated to SECTORS so the index
      // arithmetic below never has to special-case it. Cheap: 63 vertices.
      if (n === 1) {
        for (let j = 1; j < SECTORS; j++) {
          pos.push(pos[pos.length - 3], pos[pos.length - 2], pos[pos.length - 1]);
          nrm.push(0, 0, 0);
          col.push(col[col.length - 3], col[col.length - 2], col[col.length - 1]);
        }
      }
    };

    /**
     * Close the surface being built into a mesh, and start a fresh one.
     *
     * ONE WINDING FOR BOTH SURFACES, and it is worth stating why that is right
     * rather than an oversight. The deck's rings ASCEND in radius and the
     * keel's DESCEND, so the same vertex order traces the two in opposite
     * senses and the facing flips on its own: the deck comes out +Y and the
     * keel -Y, which is what a top and an underside want. Winding the second
     * one "the other way to compensate" compensates for something that already
     * happened, and is how the first pass shipped an island whose grass was a
     * black disc from above.
     */
    const flush = (receives: boolean): void => {
      for (let r = 0; r + 1 < rings.length; r++) {
        const a0 = rings[r];
        const b0 = rings[r + 1];
        for (let j = 0; j < SECTORS; j++) {
          const j1 = (j + 1) % SECTORS;
          idx.push(a0 + j, b0 + j, a0 + j1, a0 + j1, b0 + j, b0 + j1);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      geo.setIndex(idx);
      // Averaged face normals rather than the analytic gradient of `deckAt`:
      // the keel has no closed form worth differentiating and the deck's is one
      // more thing to keep in step with the surface it belongs to.
      geo.computeVertexNormals();
      if (!receives) this.wrapKeelNormals(geo, 0);
      geo.computeBoundingSphere();
      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.95, metalness: 0,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = receives;
      mesh.matrixAutoUpdate = false;
      // NOT a static shadow caster: the whole thing moves, and the cached half
      // of the shadow map is for geometry that is a pure function of the seed
      // (core/shadow-cache.ts). An island wrongly marked static drags a frozen
      // shadow across the meadow behind it.
      this.root.add(mesh);
      this.geos.push(geo);
      this.mats.push(mat);
      pos = []; nrm = []; col = []; idx = []; rings = [];
    };

    /** Deterministic per-vertex mottle, so the rock is not one flat colour. */
    const mottle = (d: number, j: number): number =>
      0.86 + 0.14 * (Math.sin(j * 2.399 + d * 17.3) * 0.5 + 0.5);

    const grassCol = (d: number, j: number): number[] => {
      // Grass thins toward the rim and gives out entirely at GRASS_EDGE, where
      // the deck becomes the bare top of the rock.
      const k = Math.min(1, Math.max(0, (d - GRASS_EDGE * 0.72) / (GRASS_EDGE * 0.28)));
      const m = mottle(d, j);
      const g = j % 2 === 0 ? GRASS : GRASS_D;
      return [
        (g[0] * (1 - k) + ROCK[0] * k) * m,
        (g[1] * (1 - k) + ROCK[1] * k) * m,
        (g[2] * (1 - k) + ROCK[2] * k) * m,
      ];
    };
    const rockCol = (d: number, j: number): number[] => {
      const m = mottle(d, j);
      // Darker the deeper it goes: the keel's `d` runs 1 -> 0 as it descends,
      // so this fades toward the point.
      const k = 1 - d;
      return [
        (ROCK_D[0] * (1 - k) + KEEL_C[0] * k) * m,
        (ROCK_D[1] * (1 - k) + KEEL_C[1] * k) * m,
        (ROCK_D[2] * (1 - k) + KEEL_C[2] * k) * m,
      ];
    };

    // THE DECK, centre outward. The outermost ring is at d = 1 exactly, where
    // `deckAt` returns -Infinity, so it is evaluated a hair inside and the rim
    // vertex takes that height — the deck and the keel then share one circle.
    const deckRing = (lx: number, lz: number): number => this.deckAt(lx * 0.999, lz * 0.999);
    for (let i = 0; i <= TOP_RINGS; i++) pushRing(i / TOP_RINGS, deckRing, grassCol);
    flush(true);

    // THE KEEL, rim downward, starting from the SAME rim ring the deck ended on
    // — same `d`, same `pushRing`, so the two surfaces meet on identical vertex
    // positions and there is no crack between the meshes.
    pushRing(1, deckRing, rockCol);
    for (let i = 1; i <= KEEL_RINGS; i++) {
      const d = 1 - i / KEEL_RINGS;
      pushRing(d, (lx, lz) => this.keelAt(lx, lz), rockCol);
    }
    flush(false);
  }
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
