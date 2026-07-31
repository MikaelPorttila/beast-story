import * as THREE from 'three';
// Type-only, so it is erased at build time and adds no import edge at runtime.
import type { PluralKey } from '../i18n';

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
  id: string;
  name: string;
  description: string;
  element: ElementType;
  targeting: SkillTargeting;
  /** Mana/stamina cost */
  cost: number;
  cooldown: number;           // seconds
  power: number;              // base damage or heal amount
  range: number;              // world units
  /** Level at which a pal learns this naturally; undefined = store-only */
  learnAtLevel?: number;
  /** Price in shards if buyable at a Skill Den; undefined = level-up only */
  storePrice?: number;
  /** Animation the casting pal should play (key into its rig animations) */
  castAnim: 'cast' | 'attack' | 'special';
}

// ---------------------------------------------------------------------------
// Pal species
// ---------------------------------------------------------------------------
export type Locomotion = 'ground' | 'flying' | 'swimming' | 'amphibious';

export interface PalStats {
  maxHp: number;
  attack: number;
  defense: number;
  speed: number;      // world units / s while following
}

/**
 * A rig is a hierarchy of voxel-built body parts. The framework animates it by
 * calling the species' animate() every frame with the current action state.
 */
export interface PalRig {
  /** Root object added to the scene (position/rotation controlled by framework) */
  root: THREE.Group;
  /** Named parts the species' animate() manipulates (head, tail, wingL, ...) */
  parts: Record<string, THREE.Object3D>;
  /** Approximate body height (root origin sits at ground/water level) */
  height: number;
  /** Approximate radius for spacing/collision */
  radius: number;
}

export type PalAction =
  | 'idle' | 'walk' | 'run' | 'swim' | 'fly'
  | 'attack' | 'cast' | 'special' | 'hurt' | 'happy';

/**
 * How many independent cycles one species may integrate through
 * `PalAnimCtx.cycle()`. Four covers the roster: a gait/wingbeat, a tail wave
 * that runs at its own rate, a secondary flutter, and Umbrakit's orbiting
 * wisps. Raise it here if a species genuinely needs a fifth — the cost is four
 * more bytes per pal.
 */
export const PAL_CYCLE_SLOTS = 4;

export interface PalAnimCtx {
  action: PalAction;
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
   * moveSpeed jumps several whole cycles per frame while a pal accelerates,
   * which is what the "wings flapping at impossible speed, like a flicker"
   * report was. Integration only ever changes the RATE from this instant on,
   * so the pose is continuous no matter how the frequency moves.
   *
   * `slot` names which cycle this is, 0..PAL_CYCLE_SLOTS-1, and is per-pal
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

export interface PalSpecies {
  id: string;
  name: string;
  element: ElementType;
  locomotion: Locomotion;
  description: string;
  baseStats: PalStats;
  /** Skill ids in learn order; SkillDef.learnAtLevel governs when */
  skills: string[];
  /** Build a fresh rig (voxel body). Must be self-contained, no async. */
  buildRig(): PalRig;
  /**
   * Procedurally animate the rig for the current frame.
   * Must be cheap; called once per pal per frame.
   */
  animate(rig: PalRig, ctx: PalAnimCtx): void;
}

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
  /** Display name, e.g. "The Encampment". */
  readonly name: string;
  /** 'camp' is the walled start town; 'hamlet' is an open settlement. */
  readonly kind: 'camp' | 'hamlet';
  readonly x: number;
  /** Levelled ground height at the centre. */
  readonly y: number;
  readonly z: number;
  /** Footprint: inside this radius of (x, z) you are in the town. */
  readonly radius: number;
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

export interface World {
  /** Terrain height at world xz (top surface, in world units) */
  getHeight(x: number, z: number): number;
  /**
   * Top of anything CLIMBABLE at world xz — terrain, and whatever else the world
   * decides to let the player grab (tree trunks today; a boss's back later).
   *
   * This is deliberately the same shape as getHeight, so climbing code asks one
   * question and does not care what it is holding onto. It is a separate query
   * because climbable and solid are not the same set: a trunk is climbable but
   * you can still walk through it, and terrain is both.
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
   * Nothing but the player does this. Pals and enemies keep their footing on
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
   * Debug: append every loaded collider as [x, z, solidRadius, climbRadius,
   * topY]. Ground is deliberately excluded — it is the whole terrain and
   * drawing it would cost more than the diagnostic is worth.
   */
  debugColliders(out: number[]): void;
  /** Positions of interest (skill dens / shops) */
  readonly shopPositions: THREE.Vector3[];
  /**
   * The named settlements in this zone, and the only sanctioned way to ask
   * where one is. See TownRegistry.
   */
  readonly towns: TownRegistry;
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
 * hp, a pal's level and known skills, the shard total — so rebuilding them on
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
 * A dropped item offered to a pal as an errand. Implemented by the drop pool in
 * src/combat/pickups.ts and consumed by PalActor, so that pals can run a fetch
 * without importing combat (and combat never learns what a pal is).
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
  /** Pal reached it: collect and credit the player. */
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
  takeDamage(amount: number, from: THREE.Vector3, element?: ElementType): void;
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
export type GameEvent =
  | { type: 'palLevelUp'; palId: string; level: number; learned?: SkillDef }
  | { type: 'skillCast'; skillId: string; casterName: string }
  | { type: 'damage'; amount: number; position: THREE.Vector3; element?: ElementType }
  | { type: 'shardsChanged'; total: number }
  /**
   * A drop left the ground. `byPal` is true when a support pal fetched it
   * rather than the player walking over it — the bag in main.ts credits both
   * the same way, only the toast differs.
   */
  | { type: 'itemPicked'; itemId: string; byPal: boolean }
  | { type: 'enemyKilled'; name: string; xp: number }
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
