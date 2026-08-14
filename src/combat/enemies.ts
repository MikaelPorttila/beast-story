import * as THREE from "three";
import { MAX_STEP_UP, inRise } from "../core/types";
import { CarrierRide } from "../world/carriers";
import { BeastAnimClock } from "../beasts/framework";
import { ALL_SPECIES } from "../beasts/registry";
import type {
  BeastAction,
  BeastRig,
  BeastSpecies,
  Damageable,
  ElementType,
  World,
} from "../core/types";
import type { StringKey } from "../i18n";
import {
  content,
  defineFactory,
  BEAST_MODEL_PREFIX,
  ENEMY_MODEL_KIND,
  type BiomeData,
  type EnemyCapture,
  type EnemyData,
} from "../content";
import { ENEMY_MODELS, type EnemyModel } from "./enemy-models";
import { displayKey, reportContentIssue } from "../core/content-bridge";
import type { VFX } from "./vfx";

// Wild enemies. A species is an `enemy:` asset (issue #60); only the VOXEL
// BUILDER is code, registered on the `enemy-model` kind at the bottom of this
// file. The AI, and the numbers that are rules rather than facts about a
// species, stayed here. Death VFX and drops are CombatSystem's.

/** A species identifier — the `name` half of an `enemy:` content id. */
export type EnemySpeciesId = string;

export interface EnemyCtx {
  world: World;
  targets: readonly Damageable[];
  vfx: VFX;
  time: number;
  hit(
    target: Damageable,
    amount: number,
    element: ElementType,
    fromX: number,
    fromY: number,
    fromZ: number,
  ): void;
}

export function variantForHeight(dh: number): number {
  if (dh < 2.5) {
    return 2;
  }
  if (dh > 11) {
    return 1;
  }
  return 0;
}

// The shapes live in enemy-models.ts, which knows nothing about content — see its header.
export type { EnemyBody, EnemyModel } from "./enemy-models";

export interface EnemySpec {
  readonly id: EnemySpeciesId;
  readonly nameKey: StringKey;
  readonly flying: boolean;
  readonly model: EnemyModel;
  readonly data: EnemyData;
  /** Hoisted off `data`, so a taming call site is one property access. */
  readonly capture: EnemyCapture | null;
}

// Resolved ONCE: `trySpawn` runs from the combat update and must not allocate.
// Keyed on content's frozen view, so a package load invalidates it by itself.
let cachedFrom: readonly unknown[] | null = null;
let cachedSpecs: readonly EnemySpec[] = [];
let cachedById: ReadonlyMap<EnemySpeciesId, EnemySpec> = new Map();

export function enemySpecies(): readonly EnemySpec[] {
  const assets = content.all<EnemyData>("enemy");
  if (assets === cachedFrom) {
    return cachedSpecs;
  }
  const specs: EnemySpec[] = [];
  for (const asset of assets) {
    const model = content.factory<EnemyModel>(ENEMY_MODEL_KIND, asset.data.model);
    if (!model) {
      reportContentIssue({
        severity: "error",
        code: "unknown-factory",
        message: `"${asset.id}" wants model "${asset.data.model}", which no builder implements`,
        assetId: asset.id,
        assetType: asset.type,
        pkg: asset.pkg,
        source: asset.source,
        field: "data.model",
        fix: `one of ${[...ENEMY_MODELS.keys()].join(", ")}`,
      });
      continue;
    }
    const nameKey = displayKey(asset);
    if (nameKey === null) {
      continue;
    }
    specs.push({
      id: asset.id.slice(asset.type.length + 1),
      nameKey,
      flying: asset.data.flying,
      model,
      data: asset.data,
      capture: asset.data.capture ?? null,
    });
  }
  cachedFrom = assets;
  cachedSpecs = specs;
  cachedById = new Map(specs.map((s) => [s.id, s]));
  return cachedSpecs;
}

/**
 * WHICH BIOME'S POPULATION IS WHICH — one resolved table per biome id, rebuilt
 * only when content changes (issue #204).
 *
 * Keyed on the frozen asset view exactly as `enemySpecies` is, so a package load
 * invalidates it by itself and a spawn roll stays a read: `trySpawn` runs from
 * the combat update and may not allocate.
 */
interface SpawnTable {
  readonly specs: readonly EnemySpec[];
  /** Running sums, so a roll is one random and a scan of a handful of entries. */
  readonly cumulative: readonly number[];
  readonly total: number;
}

let tablesFrom: readonly unknown[] | null = null;
let tables: ReadonlyMap<string, SpawnTable> = new Map();

function spawnTables(): ReadonlyMap<string, SpawnTable> {
  const assets = content.all<BiomeData>("biome");
  if (assets === tablesFrom) {
    return tables;
  }
  const out = new Map<string, SpawnTable>();
  for (const asset of assets) {
    const specs: EnemySpec[] = [];
    const cumulative: number[] = [];
    let total = 0;
    for (const entry of asset.data.spawns) {
      // An id nothing defines, or a weight of 0, is simply not in the table: the
      // asset that named it has already been reported by the cross-asset pass.
      const spec = speciesOf(entry.enemy.slice("enemy:".length));
      if (!spec || entry.weight <= 0) {
        continue;
      }
      total += entry.weight;
      specs.push(spec);
      cumulative.push(total);
    }
    if (total > 0) {
      out.set(asset.id.slice("biome:".length), { specs, cumulative, total });
    }
  }
  tablesFrom = assets;
  tables = out;
  return tables;
}

/** One species for this biome, or null where nothing lives — see `World.biomeAt`. */
export function rollSpawn(biome: string): EnemySpec | null {
  const table = spawnTables().get(biome);
  if (!table) {
    return null;
  }
  const roll = Math.random() * table.total;
  for (let i = 0; i < table.cumulative.length; i++) {
    if (roll < table.cumulative[i]) {
      return table.specs[i];
    }
  }
  return table.specs[table.specs.length - 1];
}

/** What each biome would roll, for `__dbgSpawnTables` and test-spawn-tables. */
export function spawnTableReport(): Record<string, { enemy: string; chance: number }[]> {
  const out: Record<string, { enemy: string; chance: number }[]> = {};
  for (const [biome, table] of spawnTables()) {
    out[biome] = table.specs.map((spec, i) => ({
      enemy: spec.id,
      chance: +(
        ((table.cumulative[i] - (i > 0 ? table.cumulative[i - 1] : 0)) / table.total) *
        100
      ).toFixed(1),
    }));
  }
  return out;
}

export function speciesOf(id: EnemySpeciesId): EnemySpec | undefined {
  enemySpecies();
  return cachedById.get(id);
}

/**
 * Vertical reach of a GROUND melee attack, feet-to-feet — with the horizontal
 * radius a cylinder, never an infinite column (issue #78). UP is the smallest
 * value that still shoves a mounted hero (+0.91) a MAX_STEP_UP step above; DOWN
 * is looser, or a ditch becomes cover. Exported because the hero's sword is a
 * ground melee attack too. Flyers and projectiles are exempt.
 */
export const MELEE_UP_REACH = 1.5;
export const MELEE_DOWN_REACH = 2.5;

// Cruise altitude of a wild FLYER. Matches the spawn height, so it neither sinks
// nor climbs on its first slice.
const WILD_FLY_RISE = 3.2;

// Shorter than the bite cooldown, or a beast freezes mid-lunge.
const WILD_ATTACK_SECONDS = 0.45;

/**
 * The circling half of a wild beast's fight (issue #111): it steers toward a RING
 * around its quarry and around that ring at once, alternating a PRESS (ring at
 * the bite radius, fast) with a CIRCLE (RING_OUT wider, heavy tangent, out of
 * range). A landed bite ends a press. The ring is a TARGET distance, not a wall,
 * so a far approach is still a beeline; durations are rolled per phase.
 */
const WILD_RING_OUT = 3.6;
// Weight of the TANGENT axis against a radial pull of at most 1, not an angle.
// Circling sits past 45 degrees off radial, so it gains ground and circles.
const WILD_LEAN_PRESS = 0.22;
const WILD_LEAN_CIRCLE = 1.05;
const WILD_PRESS_SECONDS = [1.1, 1.7] as const;
const WILD_CIRCLE_SECONDS = [0.7, 1.4] as const;
const WILD_SPIN_FLIP = 0.35;
/** Bite cooldown, `base + random * spread`; the average is tuned, the beat is not. */
const WILD_BITE_CD = [0.85, 0.7] as const;

const _dir = new THREE.Vector3();
const _tmp = new THREE.Vector3();

export class Enemy implements Damageable {
  private readonly ride = new CarrierRide();

  readonly position: THREE.Vector3;
  hp: number;
  maxHp: number;
  isDead = false;
  readonly faction = "wild" as const;

  readonly root = new THREE.Group();
  readonly parts: Record<string, THREE.Object3D>;
  readonly element: ElementType;
  readonly nameKey: StringKey;
  readonly xp: number;
  readonly radius: number;
  readonly height: number;
  readonly palette: readonly number[];
  readonly species: EnemySpeciesId;
  /** Which body's manners it has — the model's name unless the asset says otherwise. */
  readonly behaviour: string;
  /** On the instance, so taming.ts needs nothing but an `Enemy`. */
  readonly capture: EnemyCapture | null;
  /** The species that got built, and the payout for bonding it. */
  readonly beastSpecies: BeastSpecies | null;
  private readonly beastRig: BeastRig | null;
  // What the rig measured for ITSELF. Probes only; content stays the truth.
  readonly rigRadius: number | null;
  readonly rigHeight: number | null;
  private readonly beastClock: BeastAnimClock | null;
  private beastAction: BeastAction = "idle";
  private beastActionT = 0;

  private mats: THREE.MeshStandardMaterial[] = [];
  // Each material's emissive as BUILT. The flash must restore to this, not to
  // black, or one sword hit puts a beast's glow parts out permanently.
  private readonly baseEmissive: THREE.Color[] = [];
  private speed: number;
  private atk: number;
  private aggro: number;
  private seed = Math.random() * 100;

  private home = new THREE.Vector3();
  private goal = new THREE.Vector3();
  private knock = new THREE.Vector3();
  private vel = new THREE.Vector3();
  target: Damageable | null = null;
  private provoked = false;
  private retargetT = Math.random() * 0.25;
  private wanderT = 0;
  private atkCd = 0;
  private flashT = 0;

  // wild beast fight rhythm — see the WILD_RING_OUT block
  private wSpin = Math.random() < 0.5 ? -1 : 1;
  /** True while breaking off; false while closing. */
  private wCircling = false;
  private wPhaseT = WILD_PRESS_SECONDS[0] + Math.random() * WILD_PRESS_SECONDS[1];
  private gAir = false;
  private gVy = 0;
  private gHopY = 0;
  private gRest = 0.4;
  private gSquash = 0;
  private state: "roam" | "windup" | "charge" | "recover" = "roam";
  private stateT = 0;
  private phase = 0;
  private chargeCd = 2;
  private chargeDir = new THREE.Vector3();
  private dustT = 0;
  private pMode: "cruise" | "dive" | "climb" = "cruise";
  private orbitAngle = Math.random() * Math.PI * 2;
  private diveCd = 2 + Math.random() * 2;
  private divePoint = new THREE.Vector3();
  private diveHit = false;
  private flap = Math.random() * 10;

  private barSprite: THREE.Sprite;
  private barMat: THREE.SpriteMaterial;
  private barTex: THREE.CanvasTexture;
  private barCtx: CanvasRenderingContext2D;
  private hpDirty = false;

  // THROWS on an unknown species: an enemy with no stats has nothing to degrade
  // to, and the only callers are the spawner and the lab's `?enemy=`.
  constructor(species: EnemySpeciesId, variantIdx: number, x: number, z: number, world: World) {
    this.species = species;
    const spec = speciesOf(species);
    if (!spec) {
      throw new Error(`no enemy content for "${species}"`);
    }
    const stats = spec.data;
    // The content type refuses any other count, so this index cannot be a hole.
    const variants = stats.variants;
    const v = variants[Math.min(variantIdx, variants.length - 1)];
    this.element = v.element;
    this.nameKey = spec.nameKey;
    this.xp = stats.xp;
    this.hp = stats.hp;
    this.maxHp = stats.hp;
    this.atk = stats.atk;
    this.speed = stats.speed;
    this.radius = stats.radius;
    this.height = stats.height;
    this.aggro = stats.aggro;
    this.palette = [v.main, v.dark, v.belly, v.accent];

    // Builder BY NAME, and the AI follows the BUILDER rather than the id: a hop,
    // a charge and a dive each pose parts only one body has, so an asset that
    // picks the Gloopling's model and calls itself something else must not be
    // sent into the Peckit's dive (issue #150 found this with a story enemy that
    // reuses a shape). `behaviour` overrides it for an asset that wants another
    // body's manners with its own look.
    this.behaviour = stats.behaviour ?? stats.model;
    const body = spec.model(this.root, v);
    this.parts = body.parts;
    // A BEAST BODY POSES ITSELF: only its own species knows how to move its rig,
    // so it gets `species.animate(rig, ctx)` instead of a pose written here.
    this.beastSpecies = body.beast?.species ?? null;
    this.beastRig = body.beast?.rig ?? null;
    this.beastClock = body.beast ? new BeastAnimClock() : null;
    this.rigRadius = body.beast?.rig.radius ?? null;
    this.rigHeight = body.beast?.rig.height ?? null;
    this.capture = spec.capture;

    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && (mesh.material as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
        const mat = mesh.material as THREE.MeshStandardMaterial;
        this.mats.push(mat);
        this.baseEmissive.push(mat.emissive.clone());
      }
    });

    const groundY = world.getHeight(x, z);
    const startY = spec.flying ? Math.max(groundY, world.waterLevel) + 3.2 : groundY;
    this.root.position.set(x, startY, z);
    this.position = this.root.position;
    this.home.set(x, startY, z);
    this.goal.copy(this.home);
    this.root.rotation.y = Math.random() * Math.PI * 2;

    const canvas = document.createElement("canvas");
    canvas.width = 72;
    canvas.height = 10;
    this.barCtx = canvas.getContext("2d")!;
    this.barTex = new THREE.CanvasTexture(canvas);
    this.barTex.colorSpace = THREE.SRGBColorSpace;
    this.barMat = new THREE.SpriteMaterial({
      map: this.barTex,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.barSprite = new THREE.Sprite(this.barMat);
    this.barSprite.scale.set(0.85, 0.13, 1);
    this.barSprite.renderOrder = 15;
    this.barSprite.visible = false;
    this.root.add(this.barSprite);
    this.barSprite.position.set(0, this.height + 0.4, 0);
    this.drawBar();
  }

  // INSIDE A TAMING ORB — a THIRD state: nothing dropped and it may walk out,
  // but it cannot bite, be hit or stand anywhere. Checked beside `isDead`.
  held = false;

  // One predicate for every scan in combat/index.ts — aim assist must not lock
  // onto a held beast.
  get targetable(): boolean {
    return !this.isDead && !this.held;
  }

  setHeld(on: boolean): void {
    if (this.held === on) {
      return;
    }
    this.held = on;
    this.root.visible = !on;
    // The bar has its own `visible` and would otherwise hang over empty grass.
    this.barSprite.visible = !on && this.hp < this.maxHp;
    if (!on) {
      // Provoked: a beast that broke free and ambled off reads as forgetting.
      this.provoked = true;
      this.atkCd = Math.max(this.atkCd, 0.6);
    }
  }

  takeDamage(amount: number, from: THREE.Vector3, _element?: ElementType): boolean {
    if (this.isDead || this.held) {
      return false;
    }
    this.hp -= amount;
    this.hpDirty = true;
    this.flashT = 0.14;
    this.provoked = true;
    const knockMul = this.species === "snortle" ? 1.4 : 3.4;
    _dir.set(this.position.x - from.x, 0, this.position.z - from.z);
    if (_dir.lengthSq() > 0.001) {
      _dir.normalize().multiplyScalar(knockMul);
      this.knock.add(_dir);
    }
    if (this.hp <= 0) {
      this.hp = 0;
      this.isDead = true;
    }
    return true;
  }

  private drawBar(): void {
    const ctx = this.barCtx;
    ctx.clearRect(0, 0, 72, 10);
    ctx.fillStyle = "rgba(8,10,16,0.82)";
    ctx.fillRect(0, 0, 72, 10);
    const p = Math.max(0, this.hp / this.maxHp);
    const hue = 6 + 108 * p;
    ctx.fillStyle = `hsl(${hue}, 85%, 52%)`;
    ctx.fillRect(1.5, 1.5, 69 * p, 7);
    this.barTex.needsUpdate = true;
  }

  // DELIBERATELY HORIZONTAL, for acquiring and for the leash, unlike the melee
  // tests: noticing you and reaching you are different questions, so a thing
  // under a climber waits and only walking away drops a target.
  private retarget(ctx: EnemyCtx): void {
    this.retargetT -= 0.0166;
    if (this.retargetT > 0) {
      return;
    }
    this.retargetT = 0.22;
    const range = this.provoked ? 26 : this.aggro;
    let best: Damageable | null = null;
    let bd = range * range;
    for (const t of ctx.targets) {
      if (t.isDead) {
        continue;
      }
      const dx = t.position.x - this.position.x;
      const dz = t.position.z - this.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bd) {
        bd = d2;
        best = t;
      }
    }
    if (best) {
      this.target = best;
    } else if (this.target) {
      const dx = this.target.position.x - this.position.x;
      const dz = this.target.position.z - this.position.z;
      const leash = this.aggro * 2.2;
      if (this.target.isDead || dx * dx + dz * dz > leash * leash) {
        this.target = null;
        this.provoked = false;
      }
    }
  }

  // Called AFTER the horizontal radius check — together, a squat cylinder.
  private inMeleeHeight(t: Damageable): boolean {
    return inRise(this.position.y, t.position.y, MELEE_UP_REACH, MELEE_DOWN_REACH);
  }

  private faceToward(x: number, z: number, dt: number, rate: number): void {
    const want = Math.atan2(x - this.position.x, z - this.position.z);
    let d = want - this.root.rotation.y;
    while (d > Math.PI) {
      d -= Math.PI * 2;
    }
    while (d < -Math.PI) {
      d += Math.PI * 2;
    }
    this.root.rotation.y += d * Math.min(1, rate * dt);
  }

  // The OTHER half of the safe-zone rule: a goal inside a zone is refused like
  // one in water, so nothing wanders in. A CHASE never comes here — being chased
  // down the high street is what the zone leaves intact.
  private pickWanderGoal(ctx: EnemyCtx): void {
    const a = Math.random() * Math.PI * 2;
    const r = 2 + Math.random() * 6;
    const gx = this.home.x + Math.cos(a) * r;
    const gz = this.home.z + Math.sin(a) * r;
    if (this.species !== "peckit" && ctx.world.isWater(gx, gz)) {
      this.goal.copy(this.home);
    } else if (ctx.world.safeZones.blocksSpawn(gx, gz)) {
      this.goal.copy(this.home);
    } else {
      this.goal.set(gx, 0, gz);
    }
  }

  update(dt: number, ctx: EnemyCtx): void {
    if (this.isDead || this.held) {
      return;
    }
    // THE GROUND MOVES FIRST. `home` is deliberately NOT carried: it stays in
    // world space, so a thing that followed onto an island wants to go back.
    this.ride.carry(ctx.world, this.position);
    if (this.ride.dyaw !== 0) {
      this.root.rotation.y += this.ride.dyaw;
    }
    this.retarget(ctx);
    this.atkCd -= dt;

    // A BEAST BODY FIRST: the tests below are on a species ID, so the `else`
    // would send a wild Sproutle into Peckit's dive.
    if (this.beastSpecies) {
      this.updateWildBeast(dt, ctx);
    } else if (this.behaviour === "gloopling") {
      this.updateGloopling(dt, ctx);
    } else if (this.behaviour === "snortle") {
      this.updateSnortle(dt, ctx);
    } else if (this.behaviour === "thread-anchor") {
      // AN OBJECT (issue #202): no gait, no chase, no bite. It stands where
      // the story put it and takes what comes — killing it is the quest's
      // verb. Deliberately BEFORE the fallback, which is a diving bird.
    } else {
      this.updatePeckit(dt, ctx);
    }

    if (this.knock.lengthSq() > 0.001) {
      this.position.x += this.knock.x * dt;
      this.position.z += this.knock.z * dt;
      const d = Math.exp(-6 * dt);
      this.knock.multiplyScalar(d);
    }

    // ADDED to what the builder wrote; the ramp's last write is f = 0, which
    // restores a glow part exactly. See `baseEmissive`.
    if (this.flashT > 0) {
      this.flashT -= dt;
      const f = Math.max(0, this.flashT / 0.14) * 0.9;
      for (let i = 0; i < this.mats.length; i++) {
        const b = this.baseEmissive[i];
        this.mats[i].emissive.setRGB(b.r + f, b.g + f, b.b + f);
      }
    }

    if (this.hpDirty) {
      this.hpDirty = false;
      this.drawBar();
      this.barSprite.visible = this.hp < this.maxHp;
    }
  }

  // Terrain, or a carrier's deck. A deck IS the ground, where a settlement is a
  // thing standing on it, which is why `structureTopAt` is not folded in here.
  private groundAt(ctx: EnemyCtx, x: number, z: number): number {
    const g = ctx.world.getHeight(x, z);
    const deck = this.ride.support(x, z);
    return deck > g ? deck : g;
  }

  // Refuses water and buildings on the hero's own MAX_STEP_UP, all-or-nothing.
  private moveGround(dt: number, dirX: number, dirZ: number, spd: number, ctx: EnemyCtx): void {
    const nx = this.position.x + dirX * spd * dt;
    const nz = this.position.z + dirZ * spd * dt;
    if (ctx.world.isWater(nx, nz)) {
      return;
    }
    if (ctx.world.structureTopAt(nx, nz) > this.position.y + MAX_STEP_UP) {
      return;
    }
    this.position.x = nx;
    this.position.z = nz;
  }

  // Called on a timer AND on a landed bite, so the caller sets `wCircling`.
  private nextWildPhase(): void {
    this.wCircling = !this.wCircling;
    const [base, spread] = this.wCircling ? WILD_CIRCLE_SECONDS : WILD_PRESS_SECONDS;
    this.wPhaseT = base + Math.random() * spread;
    if (this.wCircling && Math.random() < WILD_SPIN_FLIP) {
      this.wSpin = -this.wSpin as 1 | -1;
    }
  }

  /**
   * A WILD ONE OF THE COMPANION SPECIES: walk, chase, bite, and let the species
   * pose itself — many bodies share this one AI, so no pose is written here. Not
   * `BeastActor`, which follows an owner and runs errands; what IS shared goes
   * through `BeastAnimClock`.
   */
  private updateWildBeast(dt: number, ctx: EnemyCtx): void {
    const species = this.beastSpecies!;
    const rig = this.beastRig!;
    const clock = this.beastClock!;
    const flying = species.locomotion === "flying";

    // Bite radius plus a body, so it rests at arm's length, not inside you.
    const stopAt = this.radius + 0.9;
    const chasing = this.target !== null;
    let urge = 1;

    if (this.target) {
      this.wPhaseT -= dt;
      if (this.wPhaseT <= 0) {
        this.nextWildPhase();
      }
      const t = this.target.position;
      // TWO AXES, NOT A POINT ON A RING: a leaned spot is nearly all tangent, so
      // a break-off gains no distance. Blending keeps the radius controlled.
      let ox = this.position.x - t.x;
      let oz = this.position.z - t.z;
      const cur = Math.hypot(ox, oz) || 1e-4;
      ox /= cur;
      oz /= cur;
      const ring = stopAt + (this.wCircling ? WILD_RING_OUT : 0);
      // Eases to nothing at the ring, so it settles instead of oscillating.
      const radial = Math.max(-1, Math.min(1, (ring - cur) / 1.5));
      const tang = this.wSpin * (this.wCircling ? WILD_LEAN_CIRCLE : WILD_LEAN_PRESS);
      const gx = ox * radial - oz * tang;
      const gz = oz * radial + ox * tang;
      // A goal two units along the steer: everything below reads a POINT.
      const gl = Math.hypot(gx, gz) || 1e-4;
      urge = Math.min(1, gl);
      this.goal.set(this.position.x + (gx / gl) * 2, 0, this.position.z + (gz / gl) * 2);
    } else {
      this.wanderT -= dt;
      if (this.wanderT <= 0) {
        this.wanderT = 2 + Math.random() * 3;
        this.pickWanderGoal(ctx);
      }
    }

    _dir.set(this.goal.x - this.position.x, 0, this.goal.z - this.position.z);
    const dist = _dir.length();
    if (dist > 0.01) {
      _dir.divideScalar(dist);
    }

    // A chaser's goal IS the standoff point, so only a wanderer stops short.
    const stopShort = chasing ? 0.35 : stopAt;
    // Closing sprints, breaking off lopes, so a swing reads as circling.
    const wantSpeed = this.speed * (chasing ? urge * (this.wCircling ? 1.15 : 1.6) : 0.55);
    let moved = 0;

    if (dist > stopShort) {
      if (flying) {
        this.position.x += _dir.x * wantSpeed * dt;
        this.position.z += _dir.z * wantSpeed * dt;
      } else {
        this.moveGround(dt, _dir.x, _dir.z, wantSpeed, ctx);
      }
      moved = wantSpeed;
    }
    // FACE THE QUARRY, NEVER THE GOAL — the goal is off to one side.
    if (chasing) {
      this.faceToward(this.target!.position.x, this.target!.position.z, dt, 8);
    } else if (moved > 0) {
      this.faceToward(this.goal.x, this.goal.z, dt, 7);
    }

    // A hunting flyer drops toward its quarry, or the melee band never reaches.
    const groundY = this.groundAt(ctx, this.position.x, this.position.z);
    const wantY = flying
      ? chasing
        ? Math.max(groundY + 0.6, this.target!.position.y + 0.9)
        : Math.max(groundY, ctx.world.waterLevel) + WILD_FLY_RISE
      : groundY;
    this.position.y += (wantY - this.position.y) * Math.min(1, (flying ? 3.5 : 14) * dt);

    // Same shape as the Gloopling's contact attack, vertical cap included.
    if (this.target && this.atkCd <= 0 && !this.target.isDead) {
      const dx = this.target.position.x - this.position.x;
      const dz = this.target.position.z - this.position.z;
      if (dx * dx + dz * dz < (this.radius + 1.0) ** 2 && this.inMeleeHeight(this.target)) {
        ctx.hit(
          this.target,
          this.atk,
          this.element,
          this.position.x,
          this.position.y + this.height * 0.5,
          this.position.z,
        );
        this.atkCd = WILD_BITE_CD[0] + Math.random() * WILD_BITE_CD[1];
        this.beastAction = "attack";
        this.beastActionT = 0;
        // Break off on a landed bite, rather than waiting out the cooldown in
        // the player's face (issue #111).
        this.wCircling = false; // so nextWildPhase() turns it on
        this.nextWildPhase();
      }
    }

    // `moveSpeed` normalises against the beast's OWN base speed, which is what a
    // species' gait blend is authored against — not the content `speed`.
    this.beastActionT += dt;
    const attacking = this.beastAction === "attack" && this.beastActionT < WILD_ATTACK_SECONDS;
    if (!attacking) {
      this.beastAction = "idle";
    }
    const base = species.baseStats.speed;
    const speed01 = base > 0 ? Math.min(1, moved / base) : 0;
    const gait: BeastAction = flying ? "fly" : moved <= 0.01 ? "idle" : chasing ? "run" : "walk";
    const c = clock.ctx;
    // `time` free-runs every slice (breathing, ear flicks); `actionTime` is how
    // long the CURRENT action has run, which a transient pose reads.
    c.time += dt;
    c.action = attacking ? "attack" : gait;
    c.actionTime = attacking ? this.beastActionT : c.time;
    c.moveSpeed = speed01;
    c.dt = dt;
    // A flyer's contact blob belongs on the ground, not below its belly.
    c.altitude = Math.max(0, this.position.y - Math.max(groundY, ctx.world.waterLevel));
    species.animate(rig, c);
  }

  private updateGloopling(dt: number, ctx: EnemyCtx): void {
    const body = this.parts.body;
    const groundY = this.groundAt(ctx, this.position.x, this.position.z);
    this.position.y += (groundY - this.position.y) * Math.min(1, 14 * dt);

    if (!this.gAir) {
      this.gRest -= dt;
      this.gSquash *= Math.exp(-8 * dt);
      if (this.gRest <= 0) {
        if (this.target) {
          this.goal.copy(this.target.position);
        } else {
          this.wanderT -= dt + 0.3;
          if (this.wanderT <= 0) {
            this.wanderT = 1 + Math.random() * 2;
            this.pickWanderGoal(ctx);
          }
        }
        _dir.set(this.goal.x - this.position.x, 0, this.goal.z - this.position.z);
        const dist = _dir.length();
        if (dist > 0.5) {
          _dir.divideScalar(dist);
          const hspd = this.speed * (this.target ? 1.9 : 1.0);
          this.vel.set(_dir.x * hspd, 0, _dir.z * hspd);
          this.gAir = true;
          this.gVy = this.target ? 4.6 : 3.6;
          this.gSquash = -0.55; // stretch on launch
          this.faceToward(this.goal.x, this.goal.z, 1, 60);
        } else {
          this.gRest = 0.4 + Math.random() * 0.8;
        }
      }
    } else {
      this.gVy -= 14 * dt;
      this.gHopY += this.gVy * dt;
      this.moveGround(dt, this.vel.x, this.vel.z, 1, ctx);
      if (this.gHopY <= 0) {
        this.gHopY = 0;
        this.gAir = false;
        this.gSquash = 0.7;
        this.gRest = this.target ? 0.12 + Math.random() * 0.15 : 0.5 + Math.random() * 1.1;
        ctx.vfx.dust(this.position.x, this.position.y + 0.04, this.position.z, 4);
      }
    }

    const breathe = Math.sin(ctx.time * 3.2 + this.seed) * 0.03;
    const sq = this.gAir ? -0.2 : this.gSquash;
    body.scale.set(1 + sq * 0.5 + breathe, 1 - sq * 0.55 - breathe, 1 + sq * 0.5 + breathe);
    body.position.y = this.gHopY;

    // Horizontal radius plus the vertical cap: it touches what is beside it.
    if (this.target && this.atkCd <= 0 && !this.target.isDead) {
      const dx = this.target.position.x - this.position.x;
      const dz = this.target.position.z - this.position.z;
      if (dx * dx + dz * dz < (this.radius + 0.8) ** 2 && this.inMeleeHeight(this.target)) {
        ctx.hit(
          this.target,
          this.atk,
          this.element,
          this.position.x,
          this.position.y + 0.4,
          this.position.z,
        );
        this.atkCd = 1.3;
        this.knock.set(-dx, 0, -dz).normalize().multiplyScalar(2.2);
      }
    }
  }

  private updateSnortle(dt: number, ctx: EnemyCtx): void {
    const head = this.parts.head;
    const body = this.parts.body;
    const groundY = this.groundAt(ctx, this.position.x, this.position.z);
    this.position.y += (groundY - this.position.y) * Math.min(1, 14 * dt);
    this.chargeCd -= dt;

    let moveAmt = 0;
    switch (this.state) {
      case "roam": {
        if (this.target) {
          _dir.set(
            this.target.position.x - this.position.x,
            0,
            this.target.position.z - this.position.z,
          );
          const dist = _dir.length();
          if (dist > 0.01) {
            _dir.divideScalar(dist);
          }
          if (this.chargeCd <= 0 && dist > 2.6 && dist < 8.5) {
            this.state = "windup";
            this.stateT = 0.55;
            break;
          }
          // `dist` is HORIZONTAL (_dir has y = 0); only the shove reads height.
          if (dist > this.radius + 0.9) {
            this.moveGround(dt, _dir.x, _dir.z, this.speed, ctx);
            moveAmt = this.speed;
          } else if (this.atkCd <= 0 && !this.target.isDead && this.inMeleeHeight(this.target)) {
            ctx.hit(
              this.target,
              this.atk * 0.6,
              this.element,
              this.position.x,
              this.position.y + 0.6,
              this.position.z,
            );
            this.atkCd = 1.1;
          }
          this.faceToward(this.target.position.x, this.target.position.z, dt, 9);
        } else {
          this.wanderT -= dt;
          if (this.wanderT <= 0) {
            this.wanderT = 2.5 + Math.random() * 3;
            this.pickWanderGoal(ctx);
          }
          _dir.set(this.goal.x - this.position.x, 0, this.goal.z - this.position.z);
          const dist = _dir.length();
          if (dist > 0.8) {
            _dir.divideScalar(dist);
            this.moveGround(dt, _dir.x, _dir.z, this.speed * 0.5, ctx);
            moveAmt = this.speed * 0.5;
            this.faceToward(this.goal.x, this.goal.z, dt, 5);
          }
        }
        head.rotation.x = Math.sin(ctx.time * 2 + this.seed) * 0.06;
        head.rotation.z = 0;
        break;
      }
      case "windup": {
        this.stateT -= dt;
        if (this.target) {
          this.faceToward(this.target.position.x, this.target.position.z, dt, 10);
        }
        head.rotation.z = Math.sin(ctx.time * 42) * 0.16;
        head.rotation.x = 0.3;
        this.dustT -= dt;
        if (this.dustT <= 0) {
          this.dustT = 0.1;
          const bx = this.position.x - Math.sin(this.root.rotation.y) * 0.5;
          const bz = this.position.z - Math.cos(this.root.rotation.y) * 0.5;
          ctx.vfx.dust(bx, this.position.y + 0.05, bz, 3);
        }
        if (this.stateT <= 0) {
          if (this.target) {
            this.chargeDir
              .set(
                this.target.position.x - this.position.x,
                0,
                this.target.position.z - this.position.z,
              )
              .normalize();
          } else {
            this.chargeDir.set(Math.sin(this.root.rotation.y), 0, Math.cos(this.root.rotation.y));
          }
          this.state = "charge";
          this.stateT = 1.0;
        }
        break;
      }
      case "charge": {
        this.stateT -= dt;
        head.rotation.x = 0.42;
        head.rotation.z = 0;
        const nx = this.position.x + this.chargeDir.x * 8.5 * dt;
        const nz = this.position.z + this.chargeDir.z * 8.5 * dt;
        // A charge bypasses `moveGround`, so it repeats both of its refusals.
        if (
          ctx.world.isWater(nx, nz) ||
          ctx.world.structureTopAt(nx, nz) > this.position.y + MAX_STEP_UP
        ) {
          this.state = "recover";
          this.stateT = 0.8;
          this.chargeCd = 3.5;
          break;
        }
        this.position.x = nx;
        this.position.z = nz;
        moveAmt = 8.5;
        this.faceToward(
          this.position.x + this.chargeDir.x,
          this.position.z + this.chargeDir.z,
          dt,
          30,
        );
        this.dustT -= dt;
        if (this.dustT <= 0) {
          this.dustT = 0.05;
          ctx.vfx.dust(this.position.x, this.position.y + 0.05, this.position.z, 2);
        }
        // "In the way" means at this animal's own altitude: a charge is a lunge.
        for (const t of ctx.targets) {
          if (t.isDead) {
            continue;
          }
          const dx = t.position.x - this.position.x;
          const dz = t.position.z - this.position.z;
          if (dx * dx + dz * dz < (this.radius + 0.85) ** 2 && this.inMeleeHeight(t)) {
            ctx.hit(
              t,
              this.atk * 1.5,
              this.element,
              this.position.x,
              this.position.y + 0.6,
              this.position.z,
            );
            this.state = "recover";
            this.stateT = 0.9;
            this.chargeCd = 3.5;
            break;
          }
        }
        if (this.state === "charge" && this.stateT <= 0) {
          this.state = "recover";
          this.stateT = 0.7;
          this.chargeCd = 3.2;
        }
        break;
      }
      case "recover": {
        this.stateT -= dt;
        head.rotation.x = -0.12;
        if (this.stateT <= 0) {
          this.state = "roam";
        }
        break;
      }
    }

    const gait = Math.min(1, moveAmt / this.speed);
    this.phase += moveAmt * dt * 3.4;
    const swing = Math.sin(this.phase) * 0.6 * Math.max(0.15, gait);
    (this.parts.legFL as THREE.Group).rotation.x = swing;
    (this.parts.legBR as THREE.Group).rotation.x = swing;
    (this.parts.legFR as THREE.Group).rotation.x = -swing;
    (this.parts.legBL as THREE.Group).rotation.x = -swing;
    body.position.y = 0.3 + Math.abs(Math.sin(this.phase)) * 0.035 * gait;
    body.rotation.z = Math.sin(this.phase) * 0.04 * gait;
  }

  private updatePeckit(dt: number, ctx: EnemyCtx): void {
    const body = this.parts.body;
    const head = this.parts.head;
    const wingL = this.parts.wingL;
    const wingR = this.parts.wingR;
    const groundY = Math.max(
      this.groundAt(ctx, this.position.x, this.position.z),
      ctx.world.waterLevel,
    );
    const cruiseY = groundY + 3.3 + Math.sin(ctx.time * 0.9 + this.seed) * 0.35;
    this.diveCd -= dt;

    if (this.pMode === "cruise") {
      const center = this.target ? this.target.position : this.home;
      this.orbitAngle += dt * (this.target ? 1.5 : 0.75);
      const orbitR = this.target ? 4.5 : 5.5;
      _tmp.set(
        center.x + Math.cos(this.orbitAngle) * orbitR,
        cruiseY,
        center.z + Math.sin(this.orbitAngle) * orbitR,
      );
      _dir.copy(_tmp).sub(this.position);
      const dist = _dir.length();
      if (dist > 0.01) {
        _dir.divideScalar(dist);
      }
      _dir.multiplyScalar(Math.min(this.speed, dist * 3));
      this.vel.lerp(_dir, Math.min(1, 3.5 * dt));
      if (this.target && this.diveCd <= 0 && !this.target.isDead) {
        const dx = this.target.position.x - this.position.x;
        const dz = this.target.position.z - this.position.z;
        if (dx * dx + dz * dz < 144) {
          this.pMode = "dive";
          this.divePoint.copy(this.target.position);
          this.divePoint.y += 0.8;
          this.stateT = 1.6;
          this.diveHit = false;
        }
      }
    } else if (this.pMode === "dive") {
      this.stateT -= dt;
      _dir.copy(this.divePoint).sub(this.position);
      const dist = _dir.length();
      if (dist > 0.01) {
        _dir.divideScalar(dist);
      }
      this.vel.lerp(_tmp.copy(_dir).multiplyScalar(11), Math.min(1, 8 * dt));
      ctx.vfx.trail(this.position.x, this.position.y + 0.35, this.position.z, 0xd8ecff, 0.11);
      // NOT gated by MELEE_UP_REACH: already a true 3D test, and a dive's whole
      // point is arriving from a different altitude.
      if (this.target && !this.diveHit && !this.target.isDead) {
        const d2 = _tmp
          .copy(this.target.position)
          .setY(this.target.position.y + 0.8)
          .distanceToSquared(this.position);
        if (d2 < 1.9) {
          ctx.hit(
            this.target,
            this.atk,
            this.element,
            this.position.x,
            this.position.y,
            this.position.z,
          );
          this.diveHit = true;
        }
      }
      if (dist < 1.0 || this.stateT <= 0 || this.diveHit) {
        this.pMode = "climb";
        this.stateT = 1.2;
        this.diveCd = 3.2 + Math.random() * 1.6;
      }
    } else {
      this.stateT -= dt;
      _dir.set(this.vel.x, 0, this.vel.z);
      if (_dir.lengthSq() < 0.5) {
        _dir.set(Math.sin(this.root.rotation.y), 0, Math.cos(this.root.rotation.y));
      }
      _dir.normalize();
      _tmp.set(_dir.x * 4, 5, _dir.z * 4);
      this.vel.lerp(_tmp, Math.min(1, 4 * dt));
      if (this.position.y >= cruiseY - 0.3 || this.stateT <= 0) {
        this.pMode = "cruise";
      }
    }

    this.position.addScaledVector(this.vel, dt);
    if (this.position.y < groundY + 0.7) {
      this.position.y = groundY + 0.7;
    }

    const hspd = Math.sqrt(this.vel.x * this.vel.x + this.vel.z * this.vel.z);
    if (hspd > 0.4) {
      this.faceToward(this.position.x + this.vel.x, this.position.z + this.vel.z, dt, 8);
    }
    body.rotation.x = Math.max(
      -0.8,
      Math.min(0.8, Math.atan2(-this.vel.y, Math.max(1.5, hspd)) * 0.8),
    );
    this.flap += dt * (this.pMode === "climb" ? 17 : this.pMode === "dive" ? 4 : 11);
    const flapAng = this.pMode === "dive" ? 0.32 : Math.sin(this.flap) * 0.85 - 0.1;
    wingL.rotation.z = -flapAng;
    wingR.rotation.z = flapAng;
    head.rotation.x = Math.sin(ctx.time * 2.4 + this.seed) * 0.08 - body.rotation.x * 0.5;
  }

  dispose(): void {
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry.dispose();
        const m = mesh.material;
        if (Array.isArray(m)) {
          m.forEach((mm) => mm.dispose());
        } else {
          m.dispose();
        }
      }
    });
    this.barTex.dispose();
    this.barMat.dispose();
  }
}

// ONE place a builder is named — the registration loop reads this map.
// Published at module load, before `bootstrapContent()`, so a bad `model` name
// is an `unknown-factory` finding rather than an undefined lookup at spawn.
for (const [name, model] of ENEMY_MODELS) {
  defineFactory(ENEMY_MODEL_KIND, name, model);
}

// One builder per companion species: `beast-<id>` builds the same rig
// `BeastActor` wears, so bonding needs no mapping table. DERIVED from
// `ALL_SPECIES`, or this is a second copy of the roster registry.ts owns. The
// palette is ignored — a beast paints its own.
for (const sp of ALL_SPECIES) {
  const build: EnemyModel = (root) => {
    const rig = sp.buildRig();
    root.add(rig.root);
    return { parts: rig.parts, beast: { species: sp, rig } };
  };
  defineFactory(ENEMY_MODEL_KIND, BEAST_MODEL_PREFIX + sp.id, build);
}
