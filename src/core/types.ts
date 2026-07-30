import * as THREE from 'three';

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

export interface PalAnimCtx {
  action: PalAction;
  /** Seconds since this action started */
  actionTime: number;
  /** Global time in seconds */
  time: number;
  /** 0..1 normalized speed (for gait blending) */
  moveSpeed: number;
  dt: number;
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
  /** Good spawn point on land */
  readonly spawnPoint: THREE.Vector3;
  dispose(): void;
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
  id: string;
  name: string;
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
