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
  /** Positions of interest (skill dens / shops) */
  readonly shopPositions: THREE.Vector3[];
  /** Good spawn point on land */
  readonly spawnPoint: THREE.Vector3;
  dispose(): void;
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
}

// ---------------------------------------------------------------------------
// Events (simple global bus)
// ---------------------------------------------------------------------------
export type GameEvent =
  | { type: 'palLevelUp'; palId: string; level: number; learned?: SkillDef }
  | { type: 'skillCast'; skillId: string; casterName: string }
  | { type: 'damage'; amount: number; position: THREE.Vector3; element?: ElementType }
  | { type: 'shardsChanged'; total: number }
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
