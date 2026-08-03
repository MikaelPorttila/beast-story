import * as THREE from 'three';
// Type-only, so it is erased at build time and adds no import edge at runtime.
import type { PluralKey, StringKey } from '../i18n';
// Likewise type-only, and content/types.ts itself imports nothing but the i18n
// key type — so the contract hub can name a `ContentText` (see `NpcTalk`)
// without the game growing a runtime dependency on the content layer.
import type { ContentText } from '../content/types';

// ---------------------------------------------------------------------------
// Elements / typing (Pokemon-style)
// ---------------------------------------------------------------------------
export type ElementType =
  | 'fire' | 'water' | 'grass' | 'electric' | 'ice'
  | 'rock' | 'wind' | 'shadow' | 'light' | 'dragon';

export const ELEMENT_COLORS: Record<ElementType, number> = {
  fire: 0xff6b35, water: 0x3fa7f5, grass: 0x6dbf4b, electric: 0xffd23f,
  ice: 0x9fdcf0, rock: 0xb08e5f, wind: 0xb8e8d0, shadow: 0x7a5fa8,
  light: 0xfff3c4, dragon: 0xe05580,
};

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------
export type SkillTargeting = 'projectile' | 'melee' | 'aoe' | 'self' | 'beam' | 'support';

export interface SkillDef {
  /**
   * The stable IDENTIFIER, namespaced by species ('emberfox.flame-dart'). The
   * hotbar, the cooldown map, `knownSkillIds` and the shop's already-learned
   * test all key on it, so it never changes when the skill is renamed — see
   * ItemDef.id for the same argument about the currency.
   */
  id: string;
  /** DISPLAY name, as a string-table key. Read it with `t(def.nameKey)`. */
  nameKey: StringKey;
  /** DISPLAY blurb, as a string-table key. The shop card's paragraph. */
  descriptionKey: StringKey;
  element: ElementType;
  targeting: SkillTargeting;
  /** Mana/stamina cost */
  cost: number;
  cooldown: number;           // seconds
  power: number;              // base damage or heal amount
  range: number;              // world units
  /** Level at which a beast learns this naturally; undefined = store-only */
  learnAtLevel?: number;
  /** Price in shards if buyable at a Skill Den; undefined = level-up only */
  storePrice?: number;
  /** Animation the casting beast should play (key into its rig animations) */
  castAnim: 'cast' | 'attack' | 'special';
}

// ---------------------------------------------------------------------------
// Beast species
// ---------------------------------------------------------------------------
export type Locomotion = 'ground' | 'flying' | 'swimming' | 'amphibious';

export interface BeastStats {
  maxHp: number;
  attack: number;
  defense: number;
  speed: number;      // world units / s while following
}

/**
 * A rig is a hierarchy of voxel-built body parts. The framework animates it by
 * calling the species' animate() every frame with the current action state.
 */
export interface BeastRig {
  /** Root object added to the scene (position/rotation controlled by framework) */
  root: THREE.Group;
  /** Named parts the species' animate() manipulates (head, tail, wingL, ...) */
  parts: Record<string, THREE.Object3D>;
  /** Approximate body height (root origin sits at ground/water level) */
  height: number;
  /** Approximate radius for spacing/collision */
  radius: number;
}

export type BeastAction =
  | 'idle' | 'walk' | 'run' | 'swim' | 'fly'
  | 'attack' | 'cast' | 'special' | 'hurt' | 'happy';

/**
 * How many independent cycles one species may integrate through
 * `BeastAnimCtx.cycle()`. Four covers the roster: a gait/wingbeat, a tail wave
 * that runs at its own rate, a secondary flutter, and Umbrakit's orbiting
 * wisps. Raise it here if a species genuinely needs a fifth — the cost is four
 * more bytes per beast.
 */
export const BEAST_CYCLE_SLOTS = 4;

export interface BeastAnimCtx {
  action: BeastAction;
  /** Seconds since this action started */
  actionTime: number;
  /**
   * Free-running global clock in seconds.
   *
   * Fine for cycles whose frequency is a CONSTANT — breathing, ear flicks, the
   * slow head-scan — because `time * k` then advances at a fixed rate forever.
   * It is the wrong tool the moment the frequency can change; use cycle().
   */
  time: number;
  /** 0..1 normalized speed (for gait blending) */
  moveSpeed: number;
  dt: number;
  /**
   * Phase (radians) of a cycle running at `freq` rad/s, INTEGRATED rather than
   * multiplied out of the clock. Use it for every gait, wingbeat and tail wave.
   *
   * `Math.sin(ctx.time * freq)` is discontinuous whenever `freq` moves: the
   * phase is `time * freq`, so a change of `df` retroactively rewrites the
   * whole history and teleports the phase by `time * df`. With `time` being
   * accumulated session seconds that is enormous — a wing frequency scaled by
   * moveSpeed jumps several whole cycles per frame while a beast accelerates,
   * which is what the "wings flapping at impossible speed, like a flicker"
   * report was. Integration only ever changes the RATE from this instant on,
   * so the pose is continuous no matter how the frequency moves.
   *
   * `slot` names which cycle this is, 0..BEAST_CYCLE_SLOTS-1, and is per-beast
   * state — call a given slot at most once per frame, and use the SAME slot for
   * the same body motion across every action branch so that walk->run->fly
   * changes the beat rate instead of jump-cutting the pose. Constant multiples
   * of the returned phase (`ph * 2`, `ph * 0.9`) stay continuous and are the
   * right way to derive a harmonic or a trailing wave.
   *
   * `freq` is clamped to a sane maximum by the framework, so no speed spike,
   * teleport or zone switch can produce a physically absurd beat.
   */
  cycle(slot: number, freq: number): number;
}

export interface BeastSpecies {
  /**
   * The stable IDENTIFIER ('emberfox'). The roster, `?beast=`, `/mount <id>`, the
   * lab's beast list and any future save key on it; renaming the beast is an edit to
   * src/i18n/en.ts and nothing else.
   */
  id: string;
  /** DISPLAY name, as a string-table key. Read it with `t(species.nameKey)`. */
  nameKey: StringKey;
  /** DISPLAY blurb, as a string-table key. */
  descriptionKey: StringKey;
  element: ElementType;
  locomotion: Locomotion;
  baseStats: BeastStats;
  /** Skill ids in learn order; SkillDef.learnAtLevel governs when */
  skills: string[];
  /** Build a fresh rig (voxel body). Must be self-contained, no async. */
  buildRig(): BeastRig;
  /**
   * Procedurally animate the rig for the current frame.
   * Must be cheap; called once per beast per frame.
   */
  animate(rig: BeastRig, ctx: BeastAnimCtx): void;
}

// ---------------------------------------------------------------------------
// Collision
// ---------------------------------------------------------------------------
/**
 * Highest ledge a body can walk onto. Above it, the move is refused and the
 * player has to jump.
 *
 * Lived in src/player/index.ts until settlements grew colliders, and moved here
 * because it is now the ONE rule four separate movers resolve against — the hero
 * (Player.blockTop), the saddle (MountController.blockTop), a following beast
 * (BeastActor) and a wild enemy (Enemy.moveGround) — and because the town builders
 * measure their footprints with it (see `measureFootprint` in
 * world/structures.ts): a stack of voxels no taller than this is something you
 * step onto, so it is not part of any wall. A second copy of the number is a
 * crate the hero walks over and a beast walks through.
 *
 * Terrain collision is integer-stepped — Terrain.getHeight floors the continuous
 * height — so every ledge in the natural world is a whole unit or more. Any value
 * below 1.0 therefore means the same thing there: hills must be jumped. 0.5 is
 * the middle of that range, which leaves room for a half-height PROP to be
 * walkable without ever letting a full cube through.
 *
 * The hero's JUMP_VEL/GRAVITY put his apex at 8.8^2 / (2*24) = 1.61 units, so a
 * single block is always clearable with a jump and a 2-unit face never is — that
 * gap is the point, and moving either constant changes what the world is
 * climbable.
 */
export const MAX_STEP_UP = 0.5;

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------
/**
 * The tree whose canopy a body is standing inside — see `World.crownContactAt`.
 *
 * Deliberately the raw dome the tree registry already holds rather than a
 * contact point: the caller knows where its own body is, and what it cannot get
 * anywhere else is WHICH tree and how big that tree's crown is. `treeX`/`treeZ`
 * are the trunk's axis, which is also a stable per-tree identity — the leaf
 * system hashes it for a tint, so leaves off one tree always match.
 */
export interface CrownContact {
  treeX: number;
  treeZ: number;
  /** Horizontal reach of the foliage dome, in world units. */
  crownR: number;
  /** Centre height of the dome, and its vertical semi-axis. */
  crownCy: number;
  crownRy: number;
}

/**
 * A named place on the map — the whole of what anything outside world/towns.ts
 * is allowed to know about a settlement.
 *
 * This is the QUEST-FACING contract and it is deliberately geometry-free: an
 * objective that wants to send the player to Stonewatch needs an id to key on, a
 * name to print, a point to aim a marker at and a radius to test arrival
 * against, and none of those require it to know that a town is a merged voxel
 * mesh or that its ground is a flatten disc. `gateX`/`gateZ` are here for the
 * same reason — "arrive at the gate" is a better objective than "arrive at the
 * centroid", and computing it from the road network is not something a quest
 * should be doing.
 */
export interface TownInfo {
  /** Stable across sessions and seeds; what a quest stores. */
  readonly id: string;
  /**
   * DISPLAY name as a string-table key — `t(town.nameKey)` gives "The
   * Encampment". A quest prints this; it stores `id`.
   */
  readonly nameKey: StringKey;
  /** 'camp' is the walled start town; 'hamlet' is an open settlement. */
  readonly kind: 'camp' | 'hamlet';
  readonly x: number;
  /** Levelled ground height at the centre. */
  readonly y: number;
  readonly z: number;
  /** Footprint: inside this radius of (x, z) you are in the town. */
  readonly radius: number;
  /**
   * How far the town's built PERIMETER reaches from (x, z).
   *
   * `radius` is the nominal footprint and stays a circle — arrival tests,
   * culling and keep-outs all use it. This is the circle that contains the
   * actual wall, which for a SQUARE one is its corners, 41% further out than
   * its sides. Anything levelling or clearing ground for the structures to
   * stand on wants this; anything asking "am I in the town" wants `radius`.
   */
  readonly outerRadius: number;
  /** The one road entrance, and the bearing atan2(dx, dz) it lies on. */
  readonly gateX: number;
  readonly gateZ: number;
  readonly gateAngle: number;
  /** Map/compass chip colour, 0xRRGGBB. */
  readonly color: number;
}

/**
 * Every town in a world. Empty in zones that have none.
 *
 * Three methods and no more, because those are the three questions asked of it:
 * enumerate them (a map screen, a fast-travel list), resolve one by id (a quest
 * objective), and find the one you are standing in or nearest to (an arrival
 * test, a "you have discovered..." toast).
 */
export interface TownRegistry {
  readonly all: readonly TownInfo[];
  get(id: string): TownInfo | undefined;
  nearest(x: number, z: number): TownInfo | null;
  /**
   * The roads BETWEEN those towns, each as its deck polyline flattened to
   * [x0, y0, z0, x1, y1, z1, ...].
   *
   * Here rather than buried in the world implementation because a road is a
   * gameplay object in the same way a town is: an escort that has to follow one,
   * a patrol that spawns along one, a "meet me at the crossway" objective, and —
   * today — the road tests, which walk the polyline asserting that the surface
   * under it never steps more than the hero can walk up. Flat numbers rather
   * than points because the consumer is usually iterating, and this is the same
   * layout the chunk trunk registry uses for the same reason.
   *
   * `from`/`to` are town ids, or 'junction' for the fork the network hangs off.
   */
  readonly roads: ReadonlyArray<{
    readonly id: string;
    readonly from: string;
    readonly to: string;
    readonly path: Float32Array;
    /**
     * 1 where the matching `path` sample is a BRIDGE — the deck stands over open
     * water and the ground under it was left as lake bed. Parallel to `path`
     * rather than a list of spans because every consumer walks the polyline
     * anyway, and "is this bit of road a bridge" is the question they ask.
     */
    readonly bridge: Uint8Array;
  }>;
}

// ---------------------------------------------------------------------------
// NPCs
// ---------------------------------------------------------------------------

/**
 * Someone standing in the world, as far as anything outside world/npc.ts is
 * concerned: an id, a name to print, and where they are.
 *
 * `id` is the IDENTIFIER ('gain') — what a quest stores, what `talk` takes and
 * what a hint cache keys on — and `nameKey` is DISPLAY, resolved with
 * `t(nameKey)`. Same split as TownInfo and BeastSpecies.
 */
export interface NpcInfo {
  readonly id: string;
  readonly nameKey: StringKey;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * WHAT A TALK RETURNS — and the seam a quest system drops into.
 *
 * The NPC module hands back a PAYLOAD rather than a fixed sentence, so the
 * thing that decides what someone says can change without the HUD, the interact
 * test or the frame loop changing shape. Today the payload is one line out of
 * the table; a quest offer is another field on this interface (`offer?:
 * QuestOffer`) plus a branch where main.ts renders it, and `NpcDef.talk()` in
 * world/npc.ts is the one function that has to start consulting quest state to
 * choose between them.
 *
 * UNRESOLVED TEXT AND NOT A FORMATTED STRING, because a caller may want the name
 * and the line in one composed sentence, and because the frame loop must be able
 * to ask for this without allocating — `resolveText` on the key form returns the
 * table's own string and builds nothing.
 *
 * IT IS A `ContentText` RATHER THAN A `StringKey`, and that is the one widening
 * issue #60 asked of this file. A talk line is CONTENT (src/content/types/npc.ts)
 * and content may carry its words inline — a remote pack, a quest written by a
 * tool, neither of which can have been checked against the string table this
 * build shipped. Resolving it HERE rather than in world/npc.ts is what keeps the
 * live language switch working: i18n's rule is that a string looked up on its
 * way to the DOM is free and one captured at construction owes a re-derive, and
 * a conversation begun before the player changes language must re-read, not
 * remember. Nothing else in `core/types.ts` moves: `NpcInfo.nameKey` is still a
 * `StringKey`, because the interact prompt is typed against the shipped table
 * and the engine requires the key form for a name (core/content-bridge.ts).
 */
export interface NpcTalk {
  readonly id: string;
  /** Who is speaking. Read with `resolveText`. */
  readonly name: ContentText;
  /** The line spoken. Read with `resolveText`. */
  readonly line: ContentText;
}

/**
 * The NPCs of one zone, behind the three questions asked of them: who is within
 * arm's reach, start talking to one, stop talking.
 *
 * Deliberately the same shape as TownRegistry — a query interface on the World
 * contract, with the placement, the meshes and the animation on the far side of
 * it. `nearest` runs every simulation slice from main.ts, so it allocates
 * nothing and returns the module's own record.
 */
export interface NpcField {
  readonly all: readonly NpcInfo[];
  /**
   * The closest NPC within `range` of (x, z) AND at roughly the caller's own
   * height, or null. Allocates nothing.
   *
   * `y` is the caller's FEET, matching `NpcInfo.y`, and the test it feeds is a
   * cylinder rather than a sphere — see NPC_TALK_RISE in world/npc.ts for the
   * measurements and for why the two axes are two numbers. It is not optional:
   * the query took (x, z) alone until issue #25, which is why a hero flying
   * over a settlement was offered a conversation with everyone in it.
   */
  nearest(x: number, y: number, z: number, range: number): NpcInfo | null;
  /** Begin (or restart) a conversation. Returns what to show, or null. */
  talk(id: string): NpcTalk | null;
  /** The conversation in progress, or null. */
  readonly talking: NpcTalk | null;
  endTalk(): void;
}

/**
 * How a body moves, as far as anything reacting to it is concerned.
 *
 * Two cases and not more, because they are physically different events rather
 * than two settings of one: a walker SHOVES what it passes through with its
 * body, a flyer BLOWS it from above and does not touch it at all.
 */
export type DisturbKind = 'walk' | 'fly';

/**
 * A slice of the world the F3 performance panel can hide.
 *
 * Named rather than a mesh list because the streamer keeps building: the world
 * remembers which layers are off and applies it to chunks that arrive later.
 * See `World.setLayerVisible` and `hiddenLayers` in world/index.ts.
 */
export type WorldLayer = 'grass' | 'props' | 'water' | 'clouds';

/**
 * Say that a thing is DRAWN but is not an ambient-occlusion occluder.
 *
 * The AO pass curates its own G-buffer rather than re-rendering everything (see
 * `OpaqueGTAOPass._overrideVisibility` in core/post.ts), and this is the second
 * question it asks after "did you write depth in the beauty pass". It lives here
 * rather than in either file because it is a statement the WORLD makes about its
 * own geometry and the POST STACK reads — neither imports the other.
 *
 * It is not a performance knob and must not be reached for as one. The bar is
 * that the AO the surface produces is WRONG, not that it is expensive: a grass
 * carpet is the ground rather than a thing standing on it, and a cumulus is a
 * volume of droplets with no contact shadow to cast. See issue #39, and the
 * comment at the exclusion in post.ts for the measurements.
 */
export function excludeFromAO<T extends THREE.Object3D>(obj: T): T {
  obj.userData.noAO = true;
  return obj;
}

/** Reads the mark `excludeFromAO` writes. */
export function isExcludedFromAO(obj: THREE.Object3D): boolean {
  return obj.userData.noAO === true;
}

export interface World {
  /**
   * Show or hide one layer, now and for everything streamed in afterwards.
   *
   * Distinct from `setVisible`, which takes the WHOLE world off screen for a
   * zone switch. This is the player turning the grass off to get a frame back,
   * and it has to survive walking forward into unbuilt chunks.
   */
  setLayerVisible(layer: WorldLayer, on: boolean): void;
  /**
   * Drop every streamed chunk and build it again.
   *
   * A TUNING path, not a play path: the nature densities (world/nature.ts) are
   * read while a chunk's props are being built, so a value changed at `/nature`
   * only reaches the ground already under your feet by rebuilding it. Nothing in
   * the frame loop calls this.
   */
  rebuildProps(): void;
  /** Terrain height at world xz (top surface, in world units) */
  getHeight(x: number, z: number): number;
  /**
   * Top of anything CLIMBABLE at world xz — terrain, tree trunks and crowns,
   * and EVERY SOLID THING IN THE WORLD.
   *
   * THE RULE: if it stops you, you can climb it. There is no such thing as a
   * collider that blocks movement but refuses to be grabbed, and adding one is
   * the mistake this comment exists to prevent. Settlements shipped that way
   * for exactly one commit — the boxes under `structureTopAt` were declared
   * "not climbable" on the theory that a palisade you can grab is a palisade
   * you step over, and the gate should be the only way in. That reasoning is
   * about a single wall and it silently applied to every hut, crate, cart and
   * fence in three settlements: a player who can climb a tree walks up to a
   * waist-high box in his own start town and bounces off it. A rule the world
   * follows everywhere is worth more than a locked front door, and if a
   * particular wall must not be scaled it should be TALL, not exempt.
   *
   * So this is a SUPERSET of the solid surfaces, never a different set. It is
   * still a separate query from getHeight because the reverse containment does
   * not hold — a tree crown and a bole are climbable over a footprint far wider
   * than the sliver of them that blocks movement (see trunkSolidTopAt), so
   * climbable is the bigger set in both directions it can be.
   *
   * This is deliberately the same shape as getHeight, so climbing code asks one
   * question and does not care what it is holding onto.
   *
   * It is also the SUPPORT surface: standing on a tree is the same query as
   * grabbing one, so the player resolves his feet against it too (see
   * Player.canopyTop). Where it rises clear of getHeight it is a ONE-WAY
   * PLATFORM — it holds a body that was already above it and is coming down,
   * and is not there at all for a body approaching from underneath. That
   * asymmetry is not a refinement, it is the only way a canopy can be stood on
   * without also being an invisible wall at ground level and a ceiling over
   * anyone jumping beneath it; see trunkSolidTopAt for the same argument about
   * horizontal blocking.
   *
   * Nothing but the player does this. Beasts and enemies keep their footing on
   * getHeight, so widening this query never puts a wild pack on a treetop.
   *
   * Never below getHeight(x, z) — ground is always climbable-from.
   */
  climbTopAt(x: number, z: number): number;
  /**
   * Top of the SOLID part of a tree trunk at world xz, or -Infinity where the
   * column holds no trunk.
   *
   * Separate from climbTopAt because a tree is climbable over its whole
   * footprint and solid over almost none of it. A crown is 7-10 units across
   * and sits several units up; making that column solid would ring every trunk
   * with an invisible wall, because the player's step test compares a column's
   * top against his feet and cannot tell "canopy overhead" from "cliff". So
   * only the bole blocks movement — a cylinder from the ground to the height
   * the crown starts — while the leaves above it merely hold weight.
   *
   * -Infinity rather than the ground height so a caller can tell "no trunk
   * here" from "a trunk that happens to be short" without a second query.
   */
  trunkSolidTopAt(x: number, z: number): number;
  /**
   * Top of any BUILT structure standing over this column — a hut wall, a
   * palisade span, a crate, a cart — or -Infinity where the column is clear.
   *
   * The third "what is over this column" query, and the same shape as the other
   * two on purpose: every mover in the game already resolves a column top
   * against MAX_STEP_UP, so a settlement becomes solid by being answered here
   * rather than by anyone growing a second kind of collision.
   *
   * SOLID BOTH WAYS, unlike a canopy. A tree crown had to be a one-way platform
   * because it is a lid several units above ground that would otherwise fence
   * off the trunk it belongs to; a hut wall is material standing ON the ground
   * over its whole footprint, so blocking it from every side is not a
   * compromise, it is the answer. That is also why this is a plain top rather
   * than a volume: the boxes are authored to reach from the ground up, so
   * "highest thing here" and "what stops me" are the same number.
   *
   * CLIMBABLE, like everything else that blocks. `climbTopAt` consults this,
   * so a hut roof, a crate and a palisade span can all be scaled with Shift.
   * The gate is still where you WALK in; it is no longer the only way over.
   *
   * The colliders are ORIENTED BOXES, because a hut is a rectangle: a disc
   * around one either admits the player to the corners or stops him a metre
   * short of the wall. See world/structures.ts.
   */
  structureTopAt(x: number, z: number): number;
  /**
   * Is the sphere (x, y, z, radius) inside a tree's CANOPY? Fills `out` with
   * the tree it hit and returns true; returns false and leaves `out` alone
   * otherwise.
   *
   * The third query over the same per-chunk tree registry, and the first that is
   * about the leaves rather than about standing on them: `climbTopAt` asks how
   * HIGH the canopy is over a column, this asks whether a body is INSIDE it. A
   * contact test needs the volume, not the surface — brushing through foliage
   * happens from the side, where the dome's top is nowhere near you.
   *
   * `out` is a caller-owned scratch, so a per-frame contact test allocates
   * nothing. Overlapping crowns resolve to the first tree found rather than the
   * deepest: the bucket scan would have to run to completion to know which is
   * deepest, and where two canopies interpenetrate either one is a defensible
   * answer to "what did I just walk into".
   */
  crownContactAt(x: number, y: number, z: number, radius: number, out: CrownContact): boolean;
  /**
   * How SNOW-COVERED this column is, 0..1. 0 in a zone that has no weather at
   * all (the dungeon, the lab stage).
   *
   * A CONTINUUM, not a biome flag, and that is the whole reason it is on the
   * interface: the overworld's snow line is a smoothstep several units tall
   * around an altitude that itself wanders with temperature, so "under snow" is
   * a weight, and anything reacting to it — the contact particles mix snow into
   * whatever an element sheds in proportion to this — gets to fade in over the
   * treeline instead of snapping on at a threshold. A caller that genuinely
   * wants the boolean can compare against 0.5, which is where `BiomeId` cuts.
   *
   * Deliberately narrow. The alternative was exposing the whole column record,
   * which would have put the mesher's colour scratch in the cross-module
   * contract to serve one number.
   */
  snowCoverAt(x: number, z: number): number;
  /** Water surface level (constant) */
  readonly waterLevel: number;
  isWater(x: number, z: number): boolean;
  /**
   * Stream chunks around a focus point; call every simulation slice.
   * `newFrame` marks the first slice of a rendered frame and resets the
   * per-frame chunk-building time budget — pass false on catch-up slices, or
   * a frame that runs several will do several frames' worth of building.
   */
  update(focus: THREE.Vector3, dt: number, newFrame?: boolean): void;
  /**
   * Tell the world that a body is moving through it. Call once per simulation
   * slice per mover, BEFORE `update`.
   *
   * The argument is a BODY, not a bend, and that is the whole point of the
   * shape: the caller says what is where, and the world decides what, if
   * anything, reacts to it. Today that is grass — it parts around a walker and
   * shakes under a low flyer's downwash, see world/sway.ts — and tomorrow the
   * same report is what dust, ripples and snow tracks would want. A world with
   * nothing to disturb implements it as a no-op.
   *
   * `id` must be STABLE for the life of the mover. The world keeps a lagged
   * track per id so the parted patch trails a runner and closes behind him
   * rather than snapping to his feet, and an id that changes from slice to
   * slice would show up as a body that keeps teleporting. Reserved: -1 for the
   * hero (or his mount, which reports in his place), -2 for the primary beast, -3
   * for the support beast. Anything else uses its own `Object3D.id`, which is
   * three's monotonic counter and never negative — hence the reserved ids being
   * the ones that are.
   *
   * `y` is the body's FOOT height and `radius` its horizontal half-width, so
   * the world can work out clearance over its own ground without the caller
   * having to ask.
   */
  disturb(id: number, x: number, y: number, z: number, radius: number, kind: DisturbKind): void;
  /**
   * Debug: append every loaded collider as [x, z, solidRadius, climbRadius,
   * topY]. Ground is deliberately excluded — it is the whole terrain and
   * drawing it would cost more than the diagnostic is worth.
   */
  debugColliders(out: number[]): void;
  /** Debug: the sway field's slots and tracks, or null. Allocates. */
  swayDebug?(): unknown;
  /**
   * Debug: append every structure collider as [cx, cz, hx, hz, yaw, topY].
   *
   * A SECOND method with its own stride rather than a widening of
   * `debugColliders`, because these are a different primitive: a tree is a
   * cylinder and a building is an oriented box, and squeezing a box into the
   * cylinder's five numbers is exactly the mismatch /show-colliders exists to
   * expose. See ColliderView, which draws these green like the solid discs —
   * they block the same movement.
   */
  debugStructures(out: number[]): void;
  /**
   * Debug: append every ROOF as [cx, cz, axisYaw, hl, r, yAxis, ry, fit] — a
   * cylinder lying on its side along a ridge, see `SolidRidge` in
   * world/props.ts. `fit` is how far it stands off the thatch at its worst.
   *
   * A THIRD list with a third stride, by the same argument the second one makes:
   * a roof is neither a tree's upright cylinder nor a building's box, and the
   * mismatch between a collider and the shape it is drawn as is the one thing
   * /show-colliders exists to expose.
   */
  debugRidges(out: number[]): void;
  /**
   * Debug: every lamp and fingerpost the road pass stood up, as
   * `{ kind, x, z }`, or an empty list where a zone has no roads.
   *
   * Here so a probe can measure what "lamps are too close to each other"
   * (issue #15) actually means — the smallest gap on the network, in units —
   * rather than argue it from a screenshot. Allocates; never called per frame.
   */
  debugFurniture(): Array<{ kind: string; x: number; z: number }>;
  /** Positions of interest (skill dens / shops) */
  readonly shopPositions: THREE.Vector3[];
  /**
   * The named settlements in this zone, and the only sanctioned way to ask
   * where one is. See TownRegistry.
   */
  readonly towns: TownRegistry;
  /**
   * The people standing in this zone, or null where there are none (the
   * dungeon, the lab stage). See NpcField.
   */
  readonly npcs: NpcField | null;
  /** Good spawn point on land */
  readonly spawnPoint: THREE.Vector3;
  /**
   * Chunks this world currently holds meshes for. A diagnostic, and the number
   * that proves a zone really was unloaded rather than merely hidden.
   */
  readonly chunksLoaded: number;
  /**
   * True while anything is queued or part-built around the last focus.
   *
   * This is the ZoneManager's readiness test, not decoration: a destination is
   * only walked into once it has stopped streaming, which is what moves the
   * building work into the approach (the preload band) instead of into the
   * frame the player crosses the threshold on.
   */
  readonly streaming: boolean;
  /**
   * How many chunks are queued or part-built right now.
   *
   * `streaming` answers "is there anything left", which is all the ZoneManager
   * ever needed. This answers "how much", which is what a progress bar needs:
   * `loaded / (loaded + pending)` is a real fraction of real work, where
   * `chunksLoaded` on its own has no denominator — the ring's size falls out of
   * VIEW_RADIUS and a distance test inside the streamer, and guessing it from
   * outside would be a percentage that lies the day the radius changes. See
   * the terrain stage of the boot sequence in main.ts.
   */
  readonly pendingChunks: number;
  /**
   * Show or hide everything this world has put in the scene — meshes AND
   * lights.
   *
   * It exists for the zone warm-up, and the LIGHTS are why. three keys a shader
   * program on the number of visible lights in the whole scene, not on what is
   * in frame, so warming a destination while the zone you are leaving is still
   * resident compiles it at the WRONG counts: measured, the overworld's four
   * skill-den lamps put a floor of 4 under every count, and walking into a
   * dungeon that has no lamps of its own then linked 25 programs at counts 0 and
   * 1 on arrival — the exact stall the warm-up is supposed to prevent. Standing
   * the source zone down for the duration of one warm-up render fixes it, and
   * costs nothing else: the render happens before the real one in the same
   * frame, and visibility is restored immediately after.
   */
  setVisible(v: boolean): void;
  /**
   * Give this world's GPU resources back A FEW AT A TIME. Returns true once
   * there is nothing left; call again on the next frame until it does.
   *
   * `dispose()` is the same work done all at once, which is right at shutdown
   * and wrong at a zone change: a walked-in overworld holds ~100 chunks and
   * ~300 buffer geometries, and handing the driver all of those deletions in
   * the single frame the hero crosses a threshold is the kind of spike every
   * other budget in this codebase exists to avoid.
   *
   * Honesty about what this did NOT fix: there is a ~330 ms non-CPU stall a few
   * frames after a transition in long sessions, and it is not this. It is
   * unchanged whether the old zone is disposed at 6 chunks a frame, at 1, or
   * not at all. See the note in warmUpFrame() in main.ts for what was ruled out
   * and what is left.
   */
  disposeStep(): boolean;
  dispose(): void;
}

/**
 * A subsystem that captured the active zone's `World` at construction and can
 * be handed a different one.
 *
 * Every one of these holds state that must SURVIVE a zone change — the hero's
 * hp, a beast's level and known skills, the shard total — so rebuilding them on
 * the far side of a portal is not an option. Rebinding is: the object stays,
 * the ground under it changes.
 */
export interface WorldBound {
  setWorld(world: World): void;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------
/**
 * Two kinds, because the fetch rule only has to tell them apart:
 *   currency   — the shard economy. One running total, always worth picking up.
 *   stackable  — anything you keep a count of in the bag.
 * Deliberately no equipment/consumable/quest kinds yet; add one when something
 * actually behaves differently, not in advance.
 */
export type ItemKind = 'currency' | 'stackable';

export interface ItemDef {
  /**
   * The stable IDENTIFIER. Saves, the drop table, the fetch rule and every
   * `itemDef(id)` lookup key on this, so it never changes when the item is
   * renamed — the currency is 'shard' and displays as "Cubloons".
   */
  id: string;
  /**
   * The DISPLAY name, as a string-table key rather than a string: see
   * src/i18n/en.ts, and `itemName()` in core/items.ts for reading it. It is a
   * plural base, so the table holds `<key>.one` and `<key>.other`.
   */
  nameKey: PluralKey;
  kind: ItemKind;
  /** Tint for the dropped mote, its collect burst and the bag chip. */
  color: number;
}

/**
 * A dropped item offered to a beast as an errand. Implemented by the drop pool in
 * src/combat/pickups.ts and consumed by BeastActor, so that beasts can run a fetch
 * without importing combat (and combat never learns what a beast is).
 *
 * Instances are POOLED — one per drop slot, reused. `claim()` stamps the slot's
 * generation onto the job, and every other member is dead once the slot is
 * recycled, so a job held past the end of its errand is inert rather than wrong.
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

// ---------------------------------------------------------------------------
// Combat interfaces (implemented in src/combat)
// ---------------------------------------------------------------------------
export interface Damageable {
  position: THREE.Vector3;
  hp: number;
  maxHp: number;
  isDead: boolean;
  /**
   * Apply a hit. Returns whether it actually LANDED — false when the target was
   * already dead or was inside its invulnerability window.
   *
   * The return value exists because a hit that does not land must not produce
   * feedback. `Player.takeDamage` has always had an i-frame gate (`invulnT`), but
   * `CombatSystem.onEnemyHit` could not see it: it called this and then spawned a
   * damage number, a hit burst and a red screen flash unconditionally, so an
   * absorbed hit still read on screen as a hit taken. That was survivable while
   * the feedback was cosmetic; it is not once a controller rumbles in your hands
   * for damage you did not take. Callers that genuinely do not care may still
   * ignore the result.
   */
  takeDamage(amount: number, from: THREE.Vector3, element?: ElementType): boolean;
  /** faction: 'player' side or 'wild' side */
  faction: 'player' | 'wild';
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
  /**
   * How hard a projectile is allowed to steer onto `target`, 0..1, default 1.
   * Below 1 the shot keeps the heading it was fired on and only leans toward
   * the target — which is what an aimed-by-hand shot wants: help, not autoaim.
   */
  homingScale?: number;
}

// ---------------------------------------------------------------------------
// Events (simple global bus)
// ---------------------------------------------------------------------------
/**
 * Events carry IDS and STRING-TABLE KEYS, never rendered names.
 *
 * `beastLevelUp` used to hand the HUD only `beastId`, which left the banner
 * title-casing 'emberfox' into "Emberfox" — deriving a display name from an
 * identifier, which is the exact thing the string table exists to stop, and
 * which produces "Boulderpup" in every language forever. Widening the event was
 * the fix rather than letting the HUD import the beast registry: a subsystem
 * contract belongs in this file, not in a new import edge from ui to beasts.
 *
 * PAYLOADS ARE SCALARS, and a listener MUST NOT RETAIN THE EVENT OBJECT.
 *
 * `emit` runs its listeners synchronously, so an emitter is free to hand out a
 * module-level scratch vector — several already do the equivalent, reusing
 * `_from` across every hit in a frame. That is fine for a listener that reads
 * and returns, and wrong for one that DEFERS: src/feedback drains its cues once
 * per rendered frame, by which point a retained `THREE.Vector3` has been
 * rewritten by the next hit and a retained event has aliased. Hence the position
 * on `hitDealt` is three numbers rather than a Vector3, and the old `damage`
 * variant — declared here for a long time and never once emitted — was replaced
 * by it rather than revived.
 *
 * Re-entrant emission during dispatch is already normal (`enemyKilled` grants XP
 * which emits `beastLevelUp`) and is safe: a `Set` iterated while ADDED to is
 * fine. Removing a listener mid-dispatch is not — do not unsubscribe from inside
 * a handler.
 */
export type GameEvent =
  | {
    type: 'beastLevelUp';
    /** Identifier, for anything that has to know WHICH beast. */
    beastId: string;
    /** Display name key — `t(nameKey)`. */
    nameKey: StringKey;
    level: number;
    learned?: SkillDef;
  }
  | { type: 'skillCast'; skillId: string; casterNameKey: StringKey }
  /**
   * The hero took damage that actually LANDED. Never emitted for a hit absorbed
   * by the invulnerability window — see `Damageable.takeDamage`.
   *
   * `dirX`/`dirZ` are the unit knockback heading, pointing from the attacker
   * toward the hero, which `takeDamage` has already computed to shove him with.
   * Nothing consumes the direction yet; it is carried because a directional
   * camera kick is the obvious next thing to want and re-deriving it later would
   * mean widening this event again.
   */
  | {
    type: 'playerHurt';
    amount: number;
    /**
     * `amount` as a share of the whole health bar.
     *
     * Carried rather than left to the consumer because feedback strength should
     * scale on how big the bite was, and a raw hp number cannot say that without
     * also knowing maxHp — which would mean every listener growing a second
     * field it does not otherwise want.
     */
    amountFrac: number;
    /** hp AFTER the hit, over maxHp: how close this one came to finishing him. */
    hpFrac: number;
    element?: ElementType;
    dirX: number;
    dirZ: number;
    fatal: boolean;
  }
  | { type: 'playerDied' }
  | { type: 'playerRevived' }
  /**
   * The hero hit the ground hard. `impact` is the existing landing ramp, 0 at
   * the threshold where a landing starts to register and 1 at a bone-shaker.
   */
  | { type: 'playerLanded'; impact: number }
  /**
   * Damage the PLAYER'S side dealt, and again only when it landed.
   *
   * `bySkill` separates the hero's own sword from a beast's skill, because they
   * want different feedback: the sword is in your hands and the skill is across
   * the field. `superEffective` is the element multiplier having come out above
   * 1 — the pop that already gets its own glow.
   */
  | {
    type: 'hitDealt';
    amount: number;
    crit: boolean;
    superEffective: boolean;
    element?: ElementType;
    bySkill: boolean;
    x: number;
    y: number;
    z: number;
  }
  | { type: 'mounted'; beastId: string; flying: boolean }
  | { type: 'dismounted'; beastId: string }
  | { type: 'shardsChanged'; total: number }
  /**
   * A drop left the ground. `byBeast` is true when a support beast fetched it
   * rather than the player walking over it — the bag in main.ts credits both
   * the same way, only the toast differs.
   */
  | { type: 'itemPicked'; itemId: string; byBeast: boolean }
  /**
   * `nameKey` is display, and nothing renders it yet — main.ts reads only `xp`.
   * It is a key rather than a name so that the first kill feed, quest counter or
   * damage log to show it is translated on the day it is written.
   */
  | { type: 'enemyKilled'; nameKey: StringKey; xp: number }
  | { type: 'shopOpened'; shopIndex: number }
  | { type: 'shopClosed' }
  | { type: 'toast'; text: string };

export type EventListener = (e: GameEvent) => void;

export class EventBus {
  private listeners = new Set<EventListener>();
  on(fn: EventListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(e: GameEvent): void {
    for (const fn of this.listeners) fn(e);
  }
}

// ---------------------------------------------------------------------------
// Voxel building helper contract (implemented in src/core/voxel.ts)
// ---------------------------------------------------------------------------
export interface VoxelBuildOptions {
  /** Size of one voxel cube in world units */
  scale?: number;
  /** Center the resulting geometry on x/z */
  center?: boolean;
}
