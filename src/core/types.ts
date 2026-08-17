import type * as THREE from "three";
import type { PluralKey, StringKey } from "../i18n";
import type { ContentText } from "../content/types";

export type ElementType =
  | "fire"
  | "water"
  | "grass"
  | "electric"
  | "ice"
  | "rock"
  | "wind"
  | "shadow"
  | "light"
  | "dragon";

export const ELEMENT_COLORS: Record<ElementType, number> = {
  fire: 0xff6b35,
  water: 0x3fa7f5,
  grass: 0x6dbf4b,
  electric: 0xffd23f,
  ice: 0x9fdcf0,
  rock: 0xb08e5f,
  wind: 0xb8e8d0,
  shadow: 0x7a5fa8,
  light: 0xfff3c4,
  dragon: 0xe05580,
};

export type SkillTargeting = "projectile" | "melee" | "aoe" | "self" | "beam" | "support";

export interface SkillDef {
  /** Stable id, namespaced by species ('emberfox.flame-dart'). Never renamed. */
  id: string;
  nameKey: StringKey;
  descriptionKey: StringKey;
  element: ElementType;
  targeting: SkillTargeting;
  /** Mana/stamina cost */
  cost: number;
  cooldown: number; // seconds
  power: number; // base damage or heal amount
  range: number; // world units
  /** Level at which a beast learns this naturally; undefined = store-only */
  learnAtLevel?: number;
  /** Price in shards if buyable at a Skill Den; undefined = level-up only */
  storePrice?: number;
  castAnim: "cast" | "attack" | "special";
}

export type Locomotion = "ground" | "flying" | "swimming" | "amphibious";

/** DISPLAY keys for the four gaits. 'swimming' shows as 'Aquatic' — the card names a TYPE. */
export const LOCOMOTION_NAME_KEYS: Record<Locomotion, StringKey> = {
  ground: "loco.ground.name",
  flying: "loco.flying.name",
  swimming: "loco.swimming.name",
  amphibious: "loco.amphibious.name",
};

/** What the STORY unlocks: the two aquatic gaits share one unlock (game-story.md §5). */
export type MountKind = "ground" | "water" | "flying";

/** Display and iteration order: the order the acts hand them out. */
export const MOUNT_KINDS: readonly MountKind[] = ["ground", "water", "flying"];

/** Which unlock a species answers to. */
export const MOUNT_KIND_OF: Record<Locomotion, MountKind> = {
  ground: "ground",
  flying: "flying",
  swimming: "water",
  amphibious: "water",
};

export const MOUNT_KIND_KEYS: Record<MountKind, { name: StringKey; desc: StringKey }> = {
  ground: { name: "mount.kind.ground.name", desc: "mount.kind.ground.desc" },
  water: { name: "mount.kind.water.name", desc: "mount.kind.water.desc" },
  flying: { name: "mount.kind.flying.name", desc: "mount.kind.flying.desc" },
};

export interface BeastStats {
  maxHp: number;
  attack: number;
  defense: number;
  speed: number; // world units / s while following
}

/** Voxel body parts. The framework calls the species' animate() every frame. */
export interface BeastRig {
  root: THREE.Group;
  /** Named parts animate() poses (head, tail, wingL, ...). */
  parts: Record<string, THREE.Object3D>;
  /** Body height; the root origin sits at ground/water level. */
  height: number;
  radius: number;
}

export type BeastAction =
  | "idle"
  | "walk"
  | "run"
  | "swim"
  | "fly"
  | "attack"
  | "cast"
  | "special"
  | "hurt"
  | "happy";

/** Independent cycle slots per species; four covers the roster. */
export const BEAST_CYCLE_SLOTS = 4;

export interface BeastAnimCtx {
  action: BeastAction;
  /** Seconds since this action started */
  actionTime: number;
  /** Free-running clock, seconds. Only for CONSTANT frequencies — else use cycle(). */
  time: number;
  /** 0..1 normalized speed (for gait blending) */
  moveSpeed: number;
  dt: number;
  /** Rig root height above the surface under it, world units. Undefined where the caller has no world. */
  altitude?: number;
  /**
   * Phase (radians) of a cycle at `freq` rad/s, INTEGRATED — `time * freq` teleports the phase
   * whenever freq moves. `slot` is per-beast state: one call per slot per frame, same slot per motion.
   */
  cycle(slot: number, freq: number): number;
}

export interface BeastSpecies {
  /** Stable id ('emberfox'). Renaming the beast is an edit to src/i18n/en.ts only. */
  id: string;
  nameKey: StringKey;
  descriptionKey: StringKey;
  element: ElementType;
  locomotion: Locomotion;
  baseStats: BeastStats;
  /** Skill ids in learn order; SkillDef.learnAtLevel governs when */
  skills: string[];
  /** Build a fresh rig (voxel body). Must be self-contained, no async. */
  buildRig(): BeastRig;
  /** Pose the rig for this frame. Cheap: once per beast per frame. */
  animate(rig: BeastRig, ctx: BeastAnimCtx): void;
}

/**
 * Highest ledge a body may step onto; above it the move is refused and you jump. Also what
 * `measureFootprint` treats as not-wall. Under 1.0 means every terrain ledge must be jumped
 * (heights are integer-stepped); the hero's jump apex is 1.61, so a 2-unit face never clears.
 */
export const MAX_STEP_UP = 0.5;

/**
 * Is B close to A: a CYLINDER — horizontal radius plus a vertical band, `up` and `down` separate.
 * Issue #78 is what a radius alone gives, an infinite vertical column. Squared, no allocation.
 */
export function inReach(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  radius: number,
  up: number,
  down = up,
): boolean {
  const dy = by - ay;
  if (dy > up || dy < -down) {
    return false;
  }
  const dx = bx - ax;
  const dz = bz - az;
  return dx * dx + dz * dz <= radius * radius;
}

/** The vertical half of `inReach`, for a caller that already has the horizontal answer. */
export function inRise(ay: number, by: number, up: number, down = up): boolean {
  const dy = by - ay;
  return dy <= up && dy >= -down;
}

/** The canopy dome a body stands in. `treeX`/`treeZ` are the trunk axis and double as tree identity. */
export interface CrownContact {
  treeX: number;
  treeZ: number;
  /** Horizontal reach of the foliage dome, in world units. */
  crownR: number;
  /** Centre height of the dome, and its vertical semi-axis. */
  crownCy: number;
  crownRy: number;
}

/** The quest-facing view of a settlement: deliberately geometry-free apart from point, radius and gate. */
/** What a host needs of the standing stones: where they are, and who is near one. */
export interface WaypointField {
  readonly all: readonly WaypointSpot[];
  /** The stone whose touch radius holds this point, or null. */
  touching(x: number, z: number): WaypointSpot | null;
  /**
   * The stone a hero passing HERE would notice, or null (issue #250): the
   * plate, its trail and the carriageway beside it, in a height band — so a
   * player who runs by on the road lights it and a flyer overhead does not.
   */
  sensing(x: number, y: number, z: number): WaypointSpot | null;
  /** Nearest stone this character has lit, or null when none is. */
  nearestLit(x: number, z: number, isLit: (id: string) => boolean): WaypointSpot | null;
  /** Redraw them against what the character has found; idempotent. */
  setLit(isLit: (id: string) => boolean): void;
}

export interface WaypointSpot {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Where its trail leaves the carriageway, or null where it needed none. */
  readonly from?: { readonly x: number; readonly y: number; readonly z: number } | null;
}

export interface TownInfo {
  /** Stable across sessions and seeds; what a quest stores. */
  readonly id: string;
  /**
  /** DISPLAY name key; a quest prints this and stores `id`. */
  readonly nameKey: StringKey;
  /** 'camp' is the walled start town; 'hamlet' an open settlement; 'harbour' a waterside one (issue #144). */
  readonly kind: "camp" | "hamlet" | "harbour";
  readonly x: number;
  /** Levelled ground height at the centre. */
  readonly y: number;
  readonly z: number;
  /** Footprint: inside this radius of (x, z) you are in the town. */
  readonly radius: number;
  /** Radius containing the built wall — a square town's corners are 41% past its sides. `radius` stays the footprint. */
  readonly outerRadius: number;
  /** The one road entrance, and the bearing atan2(dx, dz) it lies on. */
  readonly gateX: number;
  readonly gateZ: number;
  readonly gateAngle: number;
  /** Map/compass chip colour, 0xRRGGBB. */
  readonly color: number;
  /** CARRIED, not sited: x/y/z are a live reading, so re-read every frame and cache no distance. */
  readonly carried: boolean;
  /** How far from (x, z) the wild population may not APPEAR; 0 = no such zone. See SafeZone. */
  readonly noSpawnRadius: number;
}

/** Every town in a world. Empty in zones that have none. */
export interface TownRegistry {
  readonly all: readonly TownInfo[];
  get(id: string): TownInfo | undefined;
  nearest(x: number, z: number): TownInfo | null;
  /** Roads between towns, each a deck polyline flattened to [x0,y0,z0,...]. `from`/`to` are town ids or 'junction'. */
  readonly roads: ReadonlyArray<{
    readonly id: string;
    readonly from: string;
    readonly to: string;
    readonly path: Float32Array;
    /** 1 where the matching `path` sample is a BRIDGE: deck over water, ground left as lake bed. */
    readonly bridge: Uint8Array;
    /** The profile this path was built to — `path:<name>`. */
    readonly profile: string;
    /** Outer rim of the drawn and walked surface, world units — per profile, not a constant (issue #142 §4). */
    readonly deckEdge: number;
    /** How much loose stone the profile sheds at its verge, 0..1 — 0 is a deliberate role, not an omission. */
    readonly litter: number;
  }>;
}

/**
 * A disc the wild population may not APPEAR inside. A SPAWN RULE, NOT A WALL: a hunter follows
 * you across it; only a spawn position and a wander goal are refused. A town gets one by
 * default, a point of interest only when a designer asks.
 */
export interface SafeZone {
  /** Who claimed it — `town:encampment`, `den:2`. Namespaced because zones are diagnosed. */
  readonly id: string;
  readonly x: number;
  readonly z: number;
  /** Strictly positive; a zone is never registered at 0 (see `add`). */
  readonly radius: number;
}

/** Every safe zone in a zone-world. Loose coords, squared distances, no allocation; linear scan. */
export interface SafeZoneRegistry {
  readonly all: readonly SafeZone[];
  blocksSpawn(x: number, z: number): boolean;
  /** Claim one. radius <= 0 is a NO-OP, so a caller passes its configured radius unconditionally. */
  add(id: string, x: number, z: number, radius: number): void;
}

/**
 * A MOVING REFERENCE FRAME: a piece of world that travels, carrying what stands on it.
 *
 * NOT A REPARENTING — every mover integrates in world space. A carrier publishes the motion it
 * performed this slice (`dx/dy/dz/dyaw`), which a rider adds before its own physics, and answers
 * `topAt` so its deck is a floor by the same mechanism a hut roof is. A rider is attached exactly
 * while inside `contains`, so stepping off needs no detach event.
 */
/**
 * A moving frame seen from something standing on it: enough to turn a local
 * point into a world one every slice. `CarrierBody` implements it; NPC crews and
 * ferry stops carry one rather than the carrier itself.
 */
export interface LocalFrame {
  readonly y: number;
  readonly yaw: number;
  toWorld(lx: number, lz: number, out: { x: number; z: number }): void;
}

/** Where a balloon calls on a carried town. Every coordinate is in `frame`; `y` is the deck. */
export interface Mooring {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly boatX: number;
  readonly boatZ: number;
  readonly frame: LocalFrame;
}

/**
 * A LAMP a carried town keeps dark until something is carried to it (issue #266).
 * Every coordinate is in `frame`, like a Mooring; `y` is the deck under it.
 */
export interface LampSite {
  /** Derived, `site:lamp/<town>/<n>` — what ContentState records when it is lit. */
  readonly id: string;
  /** The `TownInfo.id` it stands in, so a quest can name the town's lamps as one site. */
  readonly town: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly frame: LocalFrame;
}

/** What a host needs of the dark lamps: where they are, and a redraw against who has lit which. */
export interface LampField {
  readonly all: readonly LampSite[];
  /** Redraw against what the character has lit; idempotent. */
  setLit(isLit: (id: string) => boolean): void;
}

export interface CarrierInfo {
  /** Stable for the life of the frame. A rider stores this, not the object. */
  readonly id: string;
  /** World-space origin of the frame — the point `yaw` turns about. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** The frame's heading, `atan2(dx, dz)` like every other angle here. */
  readonly yaw: number;
  /** How far the ride volume reaches from (x, z). A broad-phase bound. */
  readonly radius: number;
  /** What the frame moved THIS SLICE: world units, `dyaw` radians about (x, z). A delta, not a velocity. */
  readonly dx: number;
  readonly dy: number;
  readonly dz: number;
  readonly dyaw: number;
  /** Top of what a body stands on here — deck plus what is built on it — or -Infinity. Shaped like `getHeight`. */
  topAt(x: number, z: number): number;
  /** The frame's own SURFACE without what is built on it, or -Infinity past the edge — a flyer beside a cottage is over the lawn, not on it. */
  deckAt(x: number, z: number): number;
  /** Underside (keel), or +Infinity where nothing is here. Paired with `deckAt`: a frame is a MASS, so a flyer is refused entry (issue #80). */
  bottomAt(x: number, z: number): number;
  /** World (x, z) <-> frame-local. A save stores deck positions frame-local, since a carrier leaves home each session (issue #171). `out` is written, never allocated. */
  toLocal(x: number, z: number, out: { x: number; z: number }): void;
  toWorld(lx: number, lz: number, out: { x: number; z: number }): void;
  /** Inside the ride volume? TAKES `y`: the volume is the airspace ABOVE the deck only, so passing under a flying island is unaffected. */
  contains(x: number, y: number, z: number): boolean;
}

/** Every moving frame in a zone. A linear scan over a one-entry list; allocates nothing. */
export interface CarrierRegistry {
  readonly all: readonly CarrierInfo[];
  get(id: string): CarrierInfo | undefined;
  at(x: number, y: number, z: number): CarrierInfo | null;
  /** The frame whose BODY stands in this column, ignoring `y`. Unlike `at` it moves nothing — the caller compares `topAt`/`bottomAt`, so it is no surface. */
  bodyAt(x: number, z: number): CarrierInfo | null;
  /** Highest deck over this column, IGNORING the ride volume — only for a flying mount's ceiling (`FLY_CEILING`). NEVER a support surface. */
  ceilingAt(x: number, z: number): number;
  /** Move every frame one slice and publish the deltas. Called at the TOP of the slice, before any mover — `World.update` runs at the end and would lag riders. */
  advance(dt: number): void;
}

/** The registry a world with nothing that moves hands out. Shared; stateless. */
export const NO_CARRIERS: CarrierRegistry = {
  all: [],
  get: () => undefined,
  at: () => null,
  bodyAt: () => null,
  ceilingAt: () => -Infinity,
  advance: () => {},
};

/** Someone standing in the world, from outside world/npc.ts. `id` is stored, `nameKey` displayed. */
export interface NpcInfo {
  readonly id: string;
  readonly nameKey: StringKey;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Bearing he faces with nobody in front of him — toward his town's gate. His LIVE yaw is deliberately absent. */
  readonly restYaw: number;
}

/** A place to stand and a way to look, which a bare point cannot express. See `World.playerStart`. */
export interface PlayerStart {
  readonly position: THREE.Vector3;
  /** The hero's heading, `atan2(dx, dz)`. */
  readonly yaw: number;
}

/**
 * What a talk returns: a PAYLOAD, not a fixed sentence, so a quest offer becomes another field
 * here without the HUD or the frame loop changing shape. `ContentText` rather than `StringKey`
 * (issue #60) because content may carry words inline; resolve it on the way to the DOM so a live
 * language change is picked up.
 */
export interface NpcTalk {
  readonly id: string;
  /** Who is speaking. Read with `resolveText`. */
  readonly name: ContentText;
  /** The line spoken. Read with `resolveText`. */
  readonly line: ContentText;
}

/** The NPCs of one zone. `nearest` runs every slice, so it allocates nothing and returns its own record. */
export interface NpcField {
  readonly all: readonly NpcInfo[];
  /** Closest NPC within `range` of (x, z) AND near the caller's own height (`y` is FEET). A cylinder, not a column — issue #25. */
  nearest(x: number, y: number, z: number, range: number): NpcInfo | null;
  talk(id: string): NpcTalk | null;
  readonly talking: NpcTalk | null;
  endTalk(): void;
  /**
   * Put a character into FOLLOWER mode (issue #234): he leaves his placement,
   * walks after the hero along the ground, and re-stations himself the moment he
   * comes within `radius` of the destination — which is when `onArrive` fires,
   * once. A follower left too far behind teleports to the hero (the companion
   * TELEPORT_DIST precedent) — he cannot be lost, and he cannot be hurt.
   * False for an id this zone does not have, or a crew on a moving frame.
   */
  startEscort(
    id: string,
    destX: number,
    destZ: number,
    radius: number,
    onArrive: () => void,
  ): boolean;
  escorting(id: string): boolean;
  /** End every escort and return everyone to his ORIGINAL placement. Session teardown — see `exitToTitle`. */
  cancelEscorts(): void;
}

/** How a body moves: a walker SHOVES what it passes through, a flyer BLOWS from above. */
export type DisturbKind = "walk" | "fly";

/** A slice of the world the F3 panel can hide. Named, not a mesh list: chunks streamed later must honour it. */
export type WorldLayer = "grass" | "props" | "water" | "clouds";

export type TimeOfDaySource = "auto" | "quest" | "debug";

/** One allocation-free frame of the day/night system. The clock owns these vectors and colours — copy, never retain and mutate. */
export interface CelestialState {
  /** Normalised day, [0, 1): midnight 0, dawn .25, noon .5, dusk .75. */
  readonly phase: number;
  readonly source: TimeOfDaySource;
  /** Quest id responsible for a quest lock, otherwise null. */
  readonly quest: string | null;
  readonly sunDirection: THREE.Vector3;
  readonly moonDirection: THREE.Vector3;
  /** The sun by day and the moon by night: the one shadow-casting key. */
  readonly keyDirection: THREE.Vector3;
  readonly keyColor: THREE.Color;
  readonly keyIntensity: number;
  readonly bounceColor: THREE.Color;
  readonly bounceIntensity: number;
  readonly ambientSky: THREE.Color;
  readonly ambientGround: THREE.Color;
  readonly ambientIntensity: number;
  /** Multiplied with the static aerial-perspective sky ramp. */
  readonly atmosphereFilter: THREE.Color;
  readonly exposureScale: number;
  readonly daylight: number;
  readonly night: number;
  readonly stars: number;
  readonly moon: number;
}

/** Mark a DRAWN object as not an AO occluder. Not a performance knob: the bar is that its AO would be WRONG (issue #39). */
export function excludeFromAO<T extends THREE.Object3D>(obj: T): T {
  obj.userData.noAO = true;
  return obj;
}

/** Reads the mark `excludeFromAO` writes. */
export function isExcludedFromAO(obj: THREE.Object3D): boolean {
  return obj.userData.noAO === true;
}

/** Putting a building somewhere at runtime — the F3 Debug panel only. See `SpawnedSolids`. */
export interface DebugSpawner {
  /** Every part that can be stamped, by name, in the order a tree should list them. */
  names(): readonly string[];
  /** Stand one part on the terrain at (x, z). False if the name is unknown. */
  spawn(name: string, x: number, z: number, yaw: number): boolean;
  /** How many are standing. Capped — see MAX_PLACED in world/spawned.ts. */
  readonly count: number;
  /** Take them all back down. Also run by `exitToTitle`. */
  clear(): void;
}

/**
 * 'Is there built material here?' — the PLACEMENT side of the footprints `structureTopAt` is the
 * collision side of: a volume test over what is about to be stamped (issue #131). `hits` runs per
 * stamp (~1000 a chunk), `anyIn` once a chunk, so a chunk with no settlement skips the rest.
 */
export interface SiteClearance {
  /** Is anything at all stamped inside this world-space rectangle? */
  anyIn(x0: number, z0: number, x1: number, z1: number): boolean;
  /** Does built material intersect the upright cylinder of radius `r` at (x, z), from `y0` to `y1`? */
  hits(x: number, z: number, r: number, y0: number, y1: number): boolean;
}

/** A world with nothing built in it — the dungeon, the lab's stub. Shared. */
export const NO_SITE: SiteClearance = {
  anyIn: (): boolean => false,
  hits: (): boolean => false,
};

export interface World {
  /** Apply the current celestial lighting to world-owned shader materials. */
  applyCelestial(state: Readonly<CelestialState>): void;
  /** Show or hide one layer, now and for everything streamed afterwards. `setVisible` is the whole-world switch. */
  setLayerVisible(layer: WorldLayer, on: boolean): void;
  /** Ground-cover fade distance, world units. Trees and rocks keep one further chunk for the horizon silhouette. */
  setFoliageDistance(distance: number): void;
  /** Set camera-scale terrain streaming and the far clipmap/HLOD budget. */
  setTerrainDistance(distance: number): void;
  /** One consolidated far-landscape census, for the view-distance guard. */
  debugDistantTerrain(): Record<string, unknown> | null;
  /** Draw every world-owned VFX once during the boot sweep — the sweep only stages where a PLAYER goes, and the sky island's waterfall is not. */
  warmUpEffects(render: () => void): void;
  /** The carried island's waterfall counters, or null where there is neither. */
  debugSkyFall(): Record<string, number> | null;
  /** Drop and rebuild every streamed chunk. A TUNING path: nature densities are read while a chunk is built. */
  rebuildProps(): void;
  /** Terrain height at world xz (top surface, in world units) */
  getHeight(x: number, z: number): number;
  /**
   * Top of anything CLIMBABLE here — terrain, trunks, crowns and every solid thing.
   *
   * THE RULE: if it stops you, you can climb it, so this is a SUPERSET of the solid surfaces,
   * never a different set; a wall that must not be scaled should be TALL, not exempt. It is also
   * the player's SUPPORT surface, and a ONE-WAY platform where it rises clear of getHeight —
   * otherwise a canopy is a wall at ground level and a ceiling under anyone jumping beneath it.
   * Nothing but the player reads it. Never below getHeight(x, z).
   */
  climbTopAt(x: number, z: number): number;
  /** Top of the SOLID bole of a trunk, or -Infinity where there is none — a crown is climbable over a footprint that must not block movement. */
  trunkSolidTopAt(x: number, z: number): number;
  /**
   * Top of any BUILT structure over this column, or -Infinity. Shaped like the other column
   * queries, so a settlement is solid without a second kind of collision. SOLID BOTH WAYS unlike
   * a canopy, and climbable. Colliders are ORIENTED BOXES, because a hut is a rectangle.
   */
  structureTopAt(x: number, z: number): number;
  /** Is the sphere inside a tree's CANOPY? A volume, not a surface — foliage is brushed from the side. `out` is caller scratch; overlapping crowns give the first tree found. */
  crownContactAt(x: number, y: number, z: number, radius: number, out: CrownContact): boolean;
  /** Snow cover 0..1; 0 where a zone has no weather. A CONTINUUM, not a flag — `BiomeId` cuts at 0.5. */
  snowCoverAt(x: number, z: number): number;
  /**
   * The start town's taming pen, or null where no layout built one (issue #178).
   *
   * A PLACE, not a population: which animal stands in it is quest dressing and
   * main.ts's business. `r` is the ring's inner radius, so a probe can assert
   * the occupant is actually inside it.
   */
  readonly tamingPen: { x: number; y: number; z: number; r: number } | null;
  /**
   * A harbour town's pier head, or null for a town without one (issue #228).
   *
   * Where a boat CALLS: `x/z/y` is the deck column a ferry lands on (`y` the
   * deck top, not the seabed under it), `boatX/boatZ` the mooring beside it.
   */
  portOf(townId: string): { x: number; y: number; z: number; boatX: number; boatZ: number } | null;
  /**
   * A carried town's balloon berth, or null for a town without one (issue #157).
   * LOCAL to `frame`, the piece of world the town rides — resolve through it.
   */
  mooringOf(townId: string): Mooring | null;
  /**
   * The lamps a carried town keeps dark for a quest to light, or null where no
   * town flies (issue #266). Sited by the world; which are LIT is the
   * character's, in `ContentState`, like the standing stones below.
   */
  readonly lamps: LampField | null;
  /**
   * The standing stones this world grew, or an empty list where it grew none.
   *
   * A zone SITES them (they are derived from its roads); which ones are LIT is
   * the character's, and lives in `ContentState` — so the world is asked where
   * they are and never who has found them.
   */
  readonly waypoints: WaypointField | null;
  /**
   * Which country this column is — the `biome:` asset's own name (`plains`), or
   * '' for a zone that has none.
   *
   * On the contract because it is what decides the WILD POPULATION (issue #204):
   * a biome's asset carries the spawn table, and '' means nothing spawns, which
   * is how a dungeon holds only what a quest stages there.
   */
  biomeAt(x: number, z: number): string;
  /** Water surface level (constant) */
  readonly waterLevel: number;
  isWater(x: number, z: number): boolean;
  /** DEEP SEA a swimmer is turned back from — a strict subset of `isWater` (DEEP_WATER_DEPTH). False where there is no sea. */
  isDeepWater(x: number, z: number): boolean;
  /** Stream chunks around a focus; call every slice. `newFrame` resets the per-frame chunk-build budget — false on catch-up slices. */
  update(focus: THREE.Vector3, dt: number, newFrame?: boolean): void;
  /**
   * Tell the world a BODY is moving through it; once per slice per mover, BEFORE `update`. The
   * world decides what reacts (grass today). `id` must be STABLE — a lagged track per id is what
   * trails a parted patch behind a runner. Reserved: -1 hero or his mount, -2 primary beast,
   * -3 support beast; anything else uses its `Object3D.id`, never negative. `y` is FOOT height.
   */
  disturb(id: number, x: number, y: number, z: number, radius: number, kind: DisturbKind): void;
  /** Debug: colliders as [x, z, solidRadius, climbRadius, topY]. Ground excluded — it is the whole terrain. */
  debugColliders(out: number[]): void;
  /** Debug: the sway field's slots and tracks, or null. Allocates. */
  swayDebug?(): unknown;
  /** Debug: structure colliders as [cx, cz, hx, hz, yaw, topY]. Its own stride: a building is an oriented box, a tree a cylinder. */
  debugStructures(out: number[]): void;
  /** Debug: how walked the ground at (x, z) is, 0..1 — what decides grass versus packed dirt. */
  debugWear(x: number, z: number): number;
  /** Debug: the top the MESHER draws this column at, not `getHeight` — collision is the smooth deck, the drawn box a floored column under it. */
  debugColumn(x: number, z: number): number;
  /** Debug/authoring: does the straight run cross a DRAWN path? A heuristic — the router bends. */
  pathRunCrosses(ax: number, az: number, bx: number, bz: number): boolean;
  /** Would a straight run a-b hit something already STANDING (lamp, fingerpost), allowing `margin`? A runtime path arrives after the lamps. */
  pathRunHitsBuilt(ax: number, az: number, bx: number, bz: number, margin: number): boolean;
  /**
   * AUTHOR A PATH AT RUNTIME, rebuilding everything that assumed there was none (issue #142 §12a).
   * A DEVELOPER path — `/path`, `__dbgAddPath`, never gameplay: every chunk is dropped and rebuilt,
   * and `refit` is the caller's chance to re-ground the hero. Returns what was built, or `error`.
   */
  addPath(spec: {
    from: readonly [number, number];
    to: readonly [number, number];
    /** A profile name — `road`, `footpath`. Unknown names are reported. */
    profile?: string;
    /** Route THROUGH the network, junctioning the first crossing. Off by default: `AVOID_COST` is 50 so arms leave a fork separately (issue #142 §12d). */
    cross?: boolean;
    /** Called after the rebuild, to re-ground anything standing on it. */
    refit?: () => void;
  }): {
    id: string;
    length: number;
    samples: number;
    note: string | null;
    /** Junctions the merge created, and every crossing it refused. */
    nodes: Array<{ x: number; z: number; y: number; arms: number }>;
    refused: string[];
    /** DRAWN paths the finished route still crosses with no junction — stacked ribbons, issue #45. Always counted. */
    crossings: number;
    error?: string;
  };
  /**
   * Debug: every path on the network and what the clearance queries answer at a column. Unlike
   * `TownRegistry.roads` this sees beaten tracks — the issue #142 invariant is that a track is
   * visible to what GROWS (`edge`) and not to what is BUILT (`builtEdge`).
   */
  debugPaths(
    x?: number,
    z?: number,
  ): {
    paths: Array<{
      id: string;
      profile: string;
      deckHalf: number;
      deckEdge: number;
      wear: number;
      draw: boolean;
      surface: boolean;
      refusesBuilt: boolean;
      litter: number;
      x0: number;
      z0: number;
      x1: number;
      z1: number;
      /** Decimated centreline as [x, y, z], ~24 units apart — lets a probe aim a camera at a stretch of road. */
      pts: Array<[number, number, number]>;
    }>;
    at: { edge: number; builtEdge: number; wear: number; litter: number } | null;
  };
  /** Debug: show or hide every drawn ribbon and apron. False when this zone has no path network. `test-road-fade` proves the horizon dissolve with it. */
  debugPathRibbons(on: boolean): boolean;
  /** Debug: every ROOF as [cx, cz, axisYaw, hl, r, yAxis, ry, fit] — a cylinder along a ridge; `fit` is its worst standoff from the thatch. */
  debugRidges(out: number[]): void;
  /** What streamed foliage may not grow through, as volumes (issue #131). Exposed so a probe asks the same question the placer did. */
  foliageSite: SiteClearance;
  /** Debug: every lamp and fingerpost the road pass stood up — lets a probe measure the smallest gap in units (issue #15). Allocates. */
  debugFurniture(): Array<{ kind: string; x: number; z: number }>;
  /**
   * Debug: every fence the road pass built. A FENCE IS A CHAIN AND ITS BUG IS A GAP, so this is
   * `posts` in order plus `bays` joining adjacent pairs, one entry per CONTINUOUS run (issue #105).
   * Road fences and bridge railings only; a layout's own fences return a site. Allocates.
   */
  debugFences(): Array<{
    posts: Array<{ x: number; z: number; y: number; base: number; kind: string }>;
    closed: boolean;
    bays: Array<{
      from: number;
      to: number;
      length: number;
      y: number;
      /** The highest walking surface under the bay — see `FenceBay.groundMax`. */
      groundMax: number;
    }>;
  }>;
  /** Debug: a CARRIED settlement's trees in WORLD space (issue #80). Goes stale as soon as the carrier moves — read and query in one evaluation. */
  debugCarriedTrees(): Array<{ x: number; z: number }>;
  /** Debug: the carried settlement's flagged streets and each tree's clearance outside their rim, LOCAL to the carrier. Negative = a tree on flagstones. */
  debugCarriedStreets(): {
    count: number;
    paved: number;
    /** Foliage rim clearance, least first. */
    clear: number[];
  };
  /** Positions of interest (skill dens / shops) */
  readonly shopPositions: THREE.Vector3[];
  /** The named settlements in this zone, and the only sanctioned way to ask where one is. */
  readonly towns: TownRegistry;
  /** Where the wild population may not appear. See SafeZone: a spawn rule, not a wall. */
  readonly safeZones: SafeZoneRegistry;
  /** The people standing in this zone, or null where there are none. */
  readonly npcs: NpcField | null;
  /** The parts of this zone that MOVE and carry what stands on them; `NO_CARRIERS` if none. */
  readonly carriers: CarrierRegistry;
  /** Where the F3 Debug panel puts a building, or null in a zone with no part library. */
  readonly debugSpawn: DebugSpawner | null;
  /**
   * The world's REFERENCE POINT and NOT where the player begins (see `playerStart`): a scenic
   * stretch of the start town's road. Dens ring it, the streaming ring warms from it, `?cam=` and
   * `?look=` are offsets from it, and a zone's return gateway lands on it.
   */
  readonly spawnPoint: THREE.Vector3;
  /** Where a new session begins, and the hero's `atan2(dx, dz)` heading when it does. */
  readonly playerStart: PlayerStart;
  /** Chunks this world holds meshes for — proves a zone unloaded rather than merely hid. */
  readonly chunksLoaded: number;
  /** True while anything is queued or part-built. The ZoneManager's readiness test. */
  readonly streaming: boolean;
  /** Chunks queued or part-built — the denominator a progress bar needs and `chunksLoaded` has not. */
  readonly pendingChunks: number;
  /**
   * Show or hide everything this world put in the scene, meshes AND lights. three keys a shader
   * program on the scene's VISIBLE light count, so warming a destination while the old zone is
   * still lit compiles at the wrong counts — stand it down for the warm-up render.
   */
  setVisible(v: boolean): void;
  /** Give GPU resources back A FEW AT A TIME; true once nothing is left. `dispose()` does it all at once, which spikes a zone change. */
  disposeStep(): boolean;
  dispose(): void;
}

/** A subsystem holding state that must SURVIVE a zone change: rebind its `World` rather than rebuild it. */
export interface WorldBound {
  setWorld(world: World): void;
}

/**
 * WHAT AN ITEM IS FOR. A kind exists only where something BEHAVES differently on it: `currency`
 * and `beast` are never in the bag, `quest` is the one thing the panel must refuse to destroy,
 * `blueprint` carries a power BUDGET, and an `orb` is readied to a gear slot but spent at a target.
 */
export type ItemKind =
  | "currency"
  | "stackable"
  | "weapon"
  | "blueprint"
  | "potion"
  | "quest"
  | "beast"
  | "orb";

/** How loudly a slot shouts. Read by the inventory panel's border, and nothing else yet. */
export type ItemRarity = "common" | "rare" | "legendary";

/** Potion effect as optional terms, so heal-and-buff needs no new enum. `attack` needs `seconds` — a buff with no duration is permanent. */
export interface ItemEffect {
  /** Hit points restored at once. */
  heal?: number;
  /** Added to `Player.attackStat` for `seconds`. */
  attack?: number;
  seconds?: number;
}

export interface ItemDef {
  /** Stable IDENTIFIER; saves, drops and every `itemDef(id)` key on it. The currency is 'shard' and displays as 'Cubloons'. */
  id: string;
  /** DISPLAY name key. A plural base, so the table holds `<key>.one` and `<key>.other`. */
  nameKey: PluralKey;
  kind: ItemKind;
  /** Tint for the dropped mote, its collect burst and the bag chip. */
  color: number;
  /** One paragraph in the panel's detail pane. Absent = no paragraph. */
  descriptionKey?: StringKey;
  rarity?: ItemRarity;
  /** Weapon-atlas tile name (ui/weapon-icons.ts). A string, not the union: core/ must not import ui/. */
  icon?: string;
  /** Cubloons a salvage returns. Absent or 0 = the panel offers no salvage. */
  salvage?: number;
  /** Added to `Player.attackStat` while this is in the weapon slot. */
  power?: number;
  /** Which voxel model the hero holds — a `WeaponModelId` by name; core/ must not import player/. */
  model?: string;
  /** A blueprint's ceiling: how much power the forge may spend filling it in. */
  maxPower?: number;
  /** What `use` does. Only a potion has one. */
  effect?: ItemEffect;
  /** Orb quality: 1 Tame .. 4 Master. An integer because both readers want the ordering (`EnemyCapture.minTier`, `ORB_BASE`). */
  orbTier?: number;
  /** Price in Cubloons at a den. Absent = not sold. */
  storePrice?: number;
}

/**
 * A dropped item offered to a beast as an errand, so beasts fetch without importing combat.
 * Instances are POOLED: `claim()` stamps the slot's generation, so a job held too long is inert.
 */
export interface FetchJob {
  readonly itemId: string;
  /** Live position of the drop — it bobs, so re-read it every frame. */
  readonly position: THREE.Vector3;
  /** False once collected, expired, or recycled under us. */
  readonly valid: boolean;
  /** Take ownership of the drop. False if it was gone or already claimed. */
  claim(): boolean;
  /** Beast reached it: collect and credit the player. */
  collect(): void;
  /** Give up; the drop stays where it is and anyone may claim it again. */
  release(): void;
}

export interface Damageable {
  position: THREE.Vector3;
  hp: number;
  maxHp: number;
  isDead: boolean;
  /** Apply a hit. Returns whether it LANDED — false when already dead or inside i-frames, because an absorbed hit must produce no feedback. */
  takeDamage(amount: number, from: THREE.Vector3, element?: ElementType): boolean;
  faction: "player" | "wild";
}

export interface CastRequest {
  skill: SkillDef;
  caster: Damageable & { forward: THREE.Vector3 };
  origin: THREE.Vector3;
  direction: THREE.Vector3;
  /** Optional homing/aim target */
  target?: Damageable | null;
  /** Attack stat of the caster for damage scaling */
  attackStat: number;
  /** How hard a projectile may steer onto `target`, 0..1, default 1. Below 1 it only leans — aim help, not autoaim. */
  homingScale?: number;
}

/**
 * Events carry IDS and STRING-TABLE KEYS, never rendered names.
 *
 * PAYLOADS ARE SCALARS AND A LISTENER MUST NOT RETAIN THE EVENT. `emit` is synchronous, so
 * emitters hand out module-level scratch; a consumer that DEFERS (src/feedback drains once per
 * frame) would read a rewritten vector — hence three numbers on `hitDealt`, not a Vector3.
 * Re-entrant emission is safe; unsubscribing from inside a handler is not.
 */
export type GameEvent =
  | {
      type: "beastLevelUp";
      /** Identifier, for anything that has to know WHICH beast. */
      beastId: string;
      /** Display name key — `t(nameKey)`. */
      nameKey: StringKey;
      level: number;
      learned?: SkillDef;
    }
  | { type: "skillCast"; skillId: string; casterNameKey: StringKey }
  /** Damage that LANDED, never a hit absorbed by the i-frame window. `dirX`/`dirZ` are the unit knockback heading, attacker toward hero; nothing reads it yet. */
  | {
      type: "playerHurt";
      amount: number;
      /** `amount` as a share of the whole bar, so feedback scales without every listener carrying maxHp. */
      amountFrac: number;
      /** hp AFTER the hit, over maxHp: how close this one came to finishing him. */
      hpFrac: number;
      element?: ElementType;
      dirX: number;
      dirZ: number;
      fatal: boolean;
    }
  | { type: "playerDied" }
  | { type: "playerRevived" }
  /** The hero hit the ground hard. `impact` is the landing ramp: 0 at the threshold, 1 at a bone-shaker. */
  | { type: "playerLanded"; impact: number }
  /** Damage the PLAYER'S side dealt, when it landed. `bySkill` separates sword from beast skill; `superEffective` is the element multiplier above 1. */
  | {
      type: "hitDealt";
      amount: number;
      crit: boolean;
      superEffective: boolean;
      element?: ElementType;
      bySkill: boolean;
      x: number;
      y: number;
      z: number;
    }
  /** An orb left the hero's hand. Nothing acts on it: it exists so the throw FEELS like something (src/feedback). */
  | { type: "orbThrown"; orbId: string }
  /** The hero was turned back from deep water ON FOOT. Per refusal slice, unthrottled —
   * the auto-mount policy in main.ts answers it (issue #153) and everyone else ignores it. */
  | { type: "deepRefused" }
  /** An orb landed and a bond WORKED. `beastId` is the SPECIES id; an event rather than a call, because combat must not learn what a `BeastActor` is. */
  /** `beastId` is the COMPANION granted; `species` the wild INSTANCE bonded (`wild-sproutle`,
   * `penned-sproutle`) — a quest counts the instance, the roster gains the companion (issue #178). */
  | { type: "beastTamed"; beastId: string; species: string; nameKey: StringKey; orbId: string }
  /** The orb broke and the animal escaped. Separate from `beastTamed` because a listener wants one or the other. */
  | { type: "bondFailed"; beastId: string; nameKey: StringKey; orbId: string }
  /** One shake of a landed orb, 1-based, answer still unknown. Feel only; `of` lets a listener ramp. */
  | { type: "orbWobble"; index: number; of: number }
  | { type: "mounted"; beastId: string; flying: boolean }
  | { type: "dismounted"; beastId: string }
  | { type: "shardsChanged"; total: number }
  /** A drop left the ground. `byBeast` is a support beast having fetched it — only the toast differs. */
  | { type: "itemPicked"; itemId: string; byBeast: boolean }
  /** `species` is the IDENTITY a cull objective filters on; `nameKey` is display. */
  | { type: "enemyKilled"; species: string; nameKey: StringKey; xp: number }
  | { type: "shopOpened"; shopIndex: number }
  | { type: "shopClosed" }
  | { type: "toast"; text: string };

export type EventListener = (e: GameEvent) => void;

export class EventBus {
  private listeners = new Set<EventListener>();
  on(fn: EventListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(e: GameEvent): void {
    for (const fn of this.listeners) {
      fn(e);
    }
  }
}

export interface VoxelBuildOptions {
  /** Size of one voxel cube in world units */
  scale?: number;
  /** Center the resulting geometry on x/z */
  center?: boolean;
}
