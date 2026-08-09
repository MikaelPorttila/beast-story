import * as THREE from 'three';
import { VoxelModel, shade } from '../core/voxel';
import { MAX_STEP_UP, inRise } from '../core/types';
import { CarrierRide } from '../world/carriers';
import { BeastAnimClock } from '../beasts/framework';
import { ALL_SPECIES } from '../beasts/registry';
import type {
  BeastAction, BeastRig, BeastSpecies, Damageable, ElementType, World,
} from '../core/types';
import type { StringKey } from '../i18n';
import {
  content, defineFactory, BEAST_MODEL_PREFIX, ENEMY_MODEL_KIND,
  type EnemyCapture, type EnemyData, type EnemyVariant,
} from '../content';
import { displayKey, reportContentIssue } from '../core/content-bridge';
import type { VFX } from './vfx';

/**
 * Wild enemies: three voxel species with biome palette variants, terrain-aware
 * AI (idle / wander / aggro / attack), billboard hp bars, white hit-flash and
 * knockback. Death VFX + drops are orchestrated by CombatSystem.
 *
 * WHAT A SPECIES IS, AND WHERE IT IS WRITTEN DOWN. Issue #60: the roster used to
 * be three tables about the same three animals kept in step by hand — an entry
 * in a flying/not list, a row in a stats record, and a palette table named after
 * it in SCREAMING_CASE — so adding one meant finding all three. It is one
 * `enemy:` asset in src/content/data/core.json now, and the fourth thing, the
 * VOXEL BUILDER, is the only one that had to be code: it is registered on the
 * `enemy-model` factory kind at the bottom of this file and SELECTED by name.
 *
 * WHAT DID NOT MOVE: the AI. Idle, wander, aggro, attack, the terrain probes,
 * the hp bar and the hit flash are behaviour and are still here, and so are the
 * numbers that are rules about how a thing behaves rather than facts about a
 * species (`MELEE_UP_REACH` below, the spawn ring in combat/index.ts). `aggro`
 * is content because it is a radius about this animal and not a rule about how
 * anything chases.
 */

/**
 * A species identifier — the `name` half of an `enemy:` content id.
 *
 * A `string` and no longer a union, because the roster is data: a union here
 * would be a second list of the species the game has, in TypeScript, which is
 * exactly the duplication the migration removed. What keeps it honest is that
 * every id is checked against loaded content the moment it is used — `Enemy`'s
 * constructor resolves one through `speciesOf` and throws on a miss rather than
 * quietly building a nameless animal — and that the id can only come from
 * `enemySpecies()`, which is content's own list.
 */
export type EnemySpeciesId = string;

export interface EnemyCtx {
  world: World;
  targets: readonly Damageable[];
  vfx: VFX;
  time: number;
  hit(target: Damageable, amount: number, element: ElementType, fromX: number, fromY: number, fromZ: number): void;
}

/** Pick a palette variant from height above water: 0 = mid, 1 = highland, 2 = lowland. */
export function variantForHeight(dh: number): number {
  if (dh < 2.5) return 2;
  if (dh > 11) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// The roster, from content
// ---------------------------------------------------------------------------

/** One palette. Index 0 is mid, 1 is highland, 2 is lowland — `variantForHeight`. */
type Variant = EnemyVariant;

/**
 * WHAT A BUILDER HANDS BACK.
 *
 * It was the parts record alone until wild beasts landed. A beast's body is not
 * painted here — it is a `BeastSpecies` rig, the same one a companion wears —
 * and posing it means calling that species' own `animate(rig, ctx)`, which wants
 * the whole `BeastRig` and not just its parts. So the return widened rather than
 * the rig being rebuilt on the far side of the seam: building a body twice to
 * recover a reference to it is the kind of thing that is cheap exactly once and
 * then is not.
 */
export interface EnemyBody {
  /** Named parts the AI poses. For a beast body these are the rig's own. */
  readonly parts: Record<string, THREE.Object3D>;
  /**
   * Set only by a `beast-…` builder: the species and the rig it built. Present
   * means this wild thing IS one of the companion species, which is what makes
   * it bondable — see `BEAST_MODEL_PREFIX` and src/combat/taming.ts.
   */
  readonly beast?: { readonly species: BeastSpecies; readonly rig: BeastRig };
}

/** What a registered `enemy-model` does: paint a body in one palette. */
export type EnemyModel = (root: THREE.Group, v: Variant) => EnemyBody;

/**
 * One species as this file needs it: the asset's numbers, resolved against a
 * registered builder and a string-table key.
 */
export interface EnemySpec {
  readonly id: EnemySpeciesId;
  /**
   * DISPLAY name as a string-table key; `id` is the identifier. Nothing renders
   * these names YET (the kill goes out on the bus and main.ts reads only the xp
   * off it), so this is pre-emptive: the day a kill feed or a bestiary lands it
   * is already looking at a key.
   */
  readonly nameKey: StringKey;
  readonly flying: boolean;
  readonly model: EnemyModel;
  readonly data: EnemyData;
  /**
   * What it takes to bond this one, or null where it cannot be bonded at all.
   *
   * Hoisted off `data` so that the one question every taming call site asks —
   * "can I catch this?" — is one property access and never a two-step through a
   * content record. The three original enemies answer null, and that refusal is
   * half of what tools/test-taming.mjs asserts.
   */
  readonly capture: EnemyCapture | null;
}

/**
 * The species the world may spawn, resolved ONCE.
 *
 * CACHED, and that is a requirement rather than a nicety: `trySpawn` is called
 * from the combat update, and rebuilding this list per spawn would allocate an
 * array and three records inside a path the frame loop drives.
 * `content.all(type)` already answers with a cached frozen view, so the only
 * work here is the first resolve.
 *
 * The cache is keyed on that frozen view: a package loaded or released replaces
 * it, so the roster follows a lazy zone pack in without anything having to
 * remember to invalidate anything.
 */
let cachedFrom: readonly unknown[] | null = null;
let cachedSpecs: readonly EnemySpec[] = [];
let cachedById: ReadonlyMap<EnemySpeciesId, EnemySpec> = new Map();

export function enemySpecies(): readonly EnemySpec[] {
  const assets = content.all<EnemyData>('enemy');
  if (assets === cachedFrom) return cachedSpecs;
  const specs: EnemySpec[] = [];
  for (const asset of assets) {
    const model = content.factory<EnemyModel>(ENEMY_MODEL_KIND, asset.data.model);
    if (!model) {
      reportContentIssue({
        severity: 'error',
        code: 'unknown-factory',
        message: `"${asset.id}" wants model "${asset.data.model}", which no builder implements`,
        assetId: asset.id, assetType: asset.type, pkg: asset.pkg, source: asset.source,
        field: 'data.model',
        fix: `one of ${[...MODELS.keys()].join(', ')}`,
      });
      continue;
    }
    const nameKey = displayKey(asset);
    if (nameKey === null) continue;
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

/** The resolved species with this id, or undefined. Warms the cache. */
export function speciesOf(id: EnemySpeciesId): EnemySpec | undefined {
  enemySpecies();
  return cachedById.get(id);
}

// ---------------------------------------------------------------------------
// Voxel builders
// ---------------------------------------------------------------------------
function buildGloopling(root: THREE.Group, v: Variant): EnemyBody {
  const m = new VoxelModel();
  m.ellipsoid(0, 3.4, 0, 5.2, 3.4, 4.8, v.dark);
  m.ellipsoid(0, 4.5, 0, 4.7, 3.4, 4.3, v.main);
  m.ellipsoid(0, 3.0, 2.7, 2.8, 2.0, 2.3, v.belly);
  // gooey dollop on top
  m.set(0, 8, 0, v.main); m.set(0, 9, 0, v.main); m.set(1, 9, 0, v.main);
  // googly eyes (slightly proud of the surface — cute slime bulge)
  for (const sx of [-2, 2]) {
    m.set(sx, 4, 4, v.accent); m.set(sx, 5, 4, v.accent);
    m.set(sx, 6, 4, 0xf4fbff);
  }
  // grin + blush
  m.set(-1, 3, 4, v.accent); m.set(0, 2, 4, v.accent); m.set(1, 3, 4, v.accent);
  m.set(-4, 4, 3, 0xff9aa4); m.set(4, 4, 3, 0xff9aa4);
  const mesh = m.build(0.1);
  const body = new THREE.Group();
  body.add(mesh);
  root.add(body);
  return { parts: { body } };
}

function buildSnortle(root: THREE.Group, v: Variant): EnemyBody {
  // torso + bristle mane + curly tail
  const bm = new VoxelModel();
  bm.ellipsoid(0, 4.2, -0.5, 3.8, 3.4, 5.4, v.main);
  bm.ellipsoid(0, 2.8, -0.5, 3.2, 2.2, 4.6, v.belly);
  for (let z = -4; z <= 3; z++) bm.set(0, 8, z, v.dark);
  for (let z = -2; z <= 1; z++) bm.set(0, 9, z, v.dark);
  bm.set(0, 5, -7, v.dark); bm.set(0, 6, -7, v.dark); bm.set(0, 7, -6, v.dark);
  const bodyMesh = bm.build(0.1);
  const body = new THREE.Group();
  body.position.y = 0.30;
  body.add(bodyMesh);
  root.add(body);

  // head with snout, tusks, ears
  const hm = new VoxelModel();
  hm.box(0, -2, 0, 2, 2, 3, v.main);
  hm.box(0, -2, 3, 1, 0, 5, v.accent);
  hm.set(1, -1, 5, shade(v.accent, 0.55));
  hm.set(0, -1, 5, shade(v.accent, 0.55));
  hm.set(2, -1, 3, 0xf5efe0); hm.set(2, 0, 4, 0xf5efe0); hm.set(2, 1, 4, 0xf5efe0);
  hm.box(2, 2, 0, 2, 4, 1, v.dark);
  hm.set(2, 1, 2, 0x14161c);
  hm.mirrorX();
  const headMesh = hm.build(0.1);
  headMesh.position.set(0, -0.22, 0.16);
  const head = new THREE.Group();
  head.position.set(0, 0.76, 0.52);
  head.add(headMesh);
  root.add(head);

  // four stubby legs, pivot at hip
  const parts: Record<string, THREE.Object3D> = { body, head };
  const legPositions: Array<[string, number, number]> = [
    ['legFL', -0.20, 0.30], ['legFR', 0.20, 0.30],
    ['legBL', -0.20, -0.34], ['legBR', 0.20, -0.34],
  ];
  for (const [key, lx, lz] of legPositions) {
    const lm = new VoxelModel();
    lm.box(0, 1, 0, 1, 3, 1, v.dark);
    lm.box(0, 0, 0, 1, 0, 1, shade(v.dark, 0.6));
    const legMesh = lm.build(0.1);
    legMesh.position.y = -0.42;
    const leg = new THREE.Group();
    leg.position.set(lx, 0.42, lz);
    leg.add(legMesh);
    root.add(leg);
    parts[key] = leg;
  }
  return { parts };
}

function buildPeckitWing(v: Variant, sign: number): THREE.Mesh {
  const wm = new VoxelModel();
  for (let x = 1; x <= 6; x++) {
    const z0 = x <= 3 ? -1 : -1;
    const z1 = x <= 3 ? 2 : 1;
    const col = x <= 3 ? v.main : v.dark;
    for (let z = z0; z <= z1; z++) wm.set(x * sign, 0, z, col);
  }
  // feather tips
  wm.set(7 * sign, 0, 0, v.dark);
  wm.set(7 * sign, 0, -1, v.dark);
  return wm.build(0.1, false);
}

function buildPeckit(root: THREE.Group, v: Variant): EnemyBody {
  const bm = new VoxelModel();
  bm.ellipsoid(0, 3, -0.5, 2.4, 2.4, 3.6, v.main);
  bm.ellipsoid(0, 2.2, 1.4, 1.7, 1.5, 1.7, v.belly);
  // tail fan
  bm.box(-1, 3, -6, 1, 3, -4, v.main);
  bm.set(-2, 3, -6, v.dark); bm.set(2, 3, -6, v.dark);
  // little feet
  bm.set(-1, 0, 0, v.accent); bm.set(1, 0, 0, v.accent);
  const bodyMesh = bm.build(0.1);
  const body = new THREE.Group();
  body.position.y = 0.30;
  body.add(bodyMesh);
  root.add(body);

  const hm = new VoxelModel();
  hm.ellipsoid(0, 2, 0, 2.1, 2.0, 2.1, v.main);
  hm.box(0, 2, 2, 0, 2, 4, v.accent);
  hm.set(2, 2, 1, 0xf3efe2); hm.set(-2, 2, 1, 0xf3efe2);
  hm.set(2, 2, 2, 0x14141c); hm.set(-2, 2, 2, 0x14141c);
  hm.set(0, 4, 0, v.dark); hm.set(0, 5, -1, v.dark);
  const headMesh = hm.build(0.1);
  headMesh.position.y = -0.18;
  const head = new THREE.Group();
  head.position.set(0, 0.72, 0.34);
  head.add(headMesh);
  body.add(head);

  const wingL = new THREE.Group();
  wingL.position.set(-0.20, 0.34, 0.05);
  wingL.add(buildPeckitWing(v, -1));
  body.add(wingL);
  const wingR = new THREE.Group();
  wingR.position.set(0.20, 0.34, 0.05);
  wingR.add(buildPeckitWing(v, 1));
  body.add(wingR);

  return { parts: { body, head, wingL, wingR } };
}

// ---------------------------------------------------------------------------
// Melee reach in the vertical
// ---------------------------------------------------------------------------
/**
 * How far a GROUND melee attack may reach above and below the attacker's own
 * feet. Both `position.y` values compared are feet (an enemy is pinned to
 * `world.getHeight`, the hero's origin is his soles), so these are feet-to-feet.
 *
 * EXPORTED because the HERO's sword is a ground melee attack too, and it kept
 * the column these caps removed until issue #78 — he could stand on a cliff and
 * mow the valley. Both directions of the same swing answer to one pair of
 * numbers (see `meleeArc` in combat/index.ts); a second copy would drift, and
 * the drift is silent in both directions.
 *
 * Why this exists at all: every ground strike below used to test
 * `dx*dx + dz*dz` only — an infinite vertical column. That was invisible while
 * the world was a gentle heightfield and everything stood at roughly the same
 * altitude, and it became the "I climbed a tree and a Gloopling on the ground
 * still bit me" bug the moment trunks became climbable and cliffs 2-6 units
 * tall. A lunging bite covers GROUND, not altitude.
 *
 * Why a cylinder (horizontal radius + these caps) and not a plain 3D sphere:
 * a sphere of the existing ~1.3-unit radius would also shrink the HORIZONTAL
 * reach as soon as there was any height difference at all, so hits would start
 * missing on slopes and against a mounted hero — it would re-tune melee on flat
 * ground, which is not what is broken. The cylinder leaves ground combat
 * bit-for-bit as tuned and only adds the ceiling that was missing.
 *
 * UP = 1.5 is the smallest value that keeps the legitimate cases working:
 *  - a mounted hero rides +0.91 above the mount's feet (saddleY 2.1*0.72 = 1.51
 *    minus HERO_HIP_Y 0.6, see player/mount.ts), and a Snortle must still be
 *    able to shove a rider;
 *  - the hero walks up steps of MAX_STEP_UP (0.5) without climbing, so two
 *    bodies standing "next to" each other on a slope can already differ by that
 *    much before anyone has left the ground.
 * 0.91 + 0.5 = 1.41, so 1.5. It refuses everything the report is about: the
 * smallest cliff in the world is 2 units and a trunk carries the hero 5-8x his
 * own height up.
 *
 * DOWN = 2.5 is deliberately looser. Swinging downhill is the easy direction,
 * and a tight downward cap would just invent the mirror exploit — stand in a
 * ditch, become invulnerable. Being hit by something on the ledge above you
 * reads as fair in a way that being bitten by something 8 units below does not.
 *
 * Flying attackers are NOT subject to this: Peckit's dive already measured true
 * 3D distance to the target and it is supposed to come down out of the sky.
 * Ranged/projectile attacks likewise keep their reach.
 *
 * Measured in the real game, hero hanging 8.3 units up a trunk with an aggroed
 * Gloopling at its foot, 25 s per trace:
 *   caps off  strike tests 17, ALL landed at dy up to +10.9, hero 88 hp -> dead
 *   caps on   strike tests 1042, ALL refused (max dy +8.9), hero 100 hp -> 100
 *   caps on, hero back on the ground beside it: 15 tests, 15 landed, 100 -> dead
 * The enemy kept its target through the whole climb trace — it waits at the
 * foot of the tree rather than losing interest. See retarget().
 */
export const MELEE_UP_REACH = 1.5;
export const MELEE_DOWN_REACH = 2.5;

/**
 * Cruise altitude of a wild FLYER over whatever is under it, in world units.
 *
 * 3.2 is the height a flyer already spawns at (see the constructor), reused so
 * that a Galebird does not visibly sink or climb on its first slice. It is high
 * enough to read as airborne over the meadow grass, which tops out around 1.4,
 * and low enough that stooping to bite is a short drop rather than a dive — a
 * dive is Peckit's character, and a wild beast is deliberately not written as
 * one of the three characters.
 */
const WILD_FLY_RISE = 3.2;

/**
 * How long a wild beast holds its `attack` pose, in seconds.
 *
 * Shorter than the 1.2 s bite cooldown on purpose: the pose is the swing, the
 * cooldown is the recovery, and a beast frozen mid-lunge until it may bite again
 * reads as a stutter. Species author their attack over roughly this long — see
 * any `ctx.action === 'attack'` branch in src/beasts/species/.
 */
const WILD_ATTACK_SECONDS = 0.45;

/**
 * The circling half of a wild beast's fight — issue #111.
 *
 * WHAT WAS WRONG. A hunting beast copied the hero's position into `goal` every
 * slice and ran 1.6x at it, so it arrived at arm's length and STAYED there,
 * welded to his back through every dodge, biting on a metronome. Fifteen
 * species all did the identical thing, and the fight read as one animal with a
 * magnet in it.
 *
 * WHAT IT IS NOW. It steers toward a RING around its quarry and around that
 * ring at the same time, and alternates between two phases:
 *
 *   PRESS   — ring at the bite radius, little tangent, fast. It closes and bites.
 *   CIRCLE  — ring `RING_OUT` wider, heavy tangent, slower. It gives ground,
 *             swings around, and is out of biting range while it does.
 *
 * A landed bite ends a press, so the rhythm is driven by the fight and not only
 * by a clock. The ring is a TARGET distance, not a wall: out on the meadow it
 * is far nearer than the beast is and the approach is the beeline it always
 * was, so the rhythm only appears once the fight is joined — which is where the
 * issue is.
 *
 * Every duration below is a RANGE rolled per phase and `spin` flips on some
 * transitions, so two of the same species fighting the same hero neither swing
 * in lockstep nor ride a carousel.
 */
const WILD_RING_OUT = 3.6;
/**
 * How much TANGENT goes into the steer, against a radial pull of at most 1.
 *
 * Not an angle: the chase steers on two axes (toward the ring, and around it)
 * and this is the weight of the second. 0.22 while closing is a curve on the
 * approach and, once it is sitting on the ring, a slow prowl around its quarry
 * rather than a statue at arm's length. 1.05 while breaking off puts the swing
 * a shade past 45 degrees off radial, so it gains ground and circles at once.
 */
const WILD_LEAN_PRESS = 0.22;
const WILD_LEAN_CIRCLE = 1.05;
/** Phase lengths, seconds: `base + Math.random() * spread`. */
const WILD_PRESS_SECONDS = [1.1, 1.7] as const;
const WILD_CIRCLE_SECONDS = [0.7, 1.4] as const;
/** Odds a circle phase reverses the direction it swings. */
const WILD_SPIN_FLIP = 0.35;
/**
 * Bite cooldown, seconds, as `base + Math.random() * spread`.
 *
 * Was a flat 1.2. The average is deliberately unchanged — the complaint is the
 * METRONOME, not the damage rate, and a beast that bit slower would just be a
 * nerf wearing this issue's number.
 */
const WILD_BITE_CD = [0.85, 0.7] as const;

// ---------------------------------------------------------------------------
// Enemy
// ---------------------------------------------------------------------------
const _dir = new THREE.Vector3();
const _tmp = new THREE.Vector3();

export class Enemy implements Damageable {
  /** The moving frame under its feet, if any. See world/carriers.ts. */
  private readonly ride = new CarrierRide();

  readonly position: THREE.Vector3;
  hp: number;
  maxHp: number;
  isDead = false;
  readonly faction = 'wild' as const;

  readonly root = new THREE.Group();
  readonly parts: Record<string, THREE.Object3D>;
  readonly element: ElementType;
  /** DISPLAY name key; `species` above is the identifier. */
  readonly nameKey: StringKey;
  readonly xp: number;
  readonly radius: number;
  readonly height: number;
  readonly palette: readonly number[];
  readonly species: EnemySpeciesId;
  /**
   * What it takes to bond this one, or null. See `EnemySpec.capture`.
   *
   * On the instance rather than looked up per throw because src/combat/taming.ts
   * is handed an `Enemy` and nothing else — it must not have to know that a
   * species id resolves through a content cache to answer "can I catch this".
   */
  readonly capture: EnemyCapture | null;
  /**
   * The companion species this wild thing IS, or null for the painted enemies.
   *
   * It is both the body (its rig is what got built) and the payout (bonding it
   * grants this species), which is the single-source-of-truth argument written
   * on `EnemyCapture`.
   */
  readonly beastSpecies: BeastSpecies | null;
  private readonly beastRig: BeastRig | null;
  /**
   * What the beast rig measured for ITSELF, or null on a painted enemy.
   *
   * Exposed only so a probe can compare it against the authored `radius`/
   * `height` above — see the note on those fields in
   * src/content/types/enemy.ts. Nothing in the game reads these: content is the
   * truth for what the game reaches with, and this is the second opinion that
   * says whether that truth still matches the model.
   */
  readonly rigRadius: number | null;
  readonly rigHeight: number | null;
  /** Phase integrator for `beastSpecies.animate`. Null for a painted enemy. */
  private readonly beastClock: BeastAnimClock | null;
  private beastAction: BeastAction = 'idle';
  private beastActionT = 0;

  private mats: THREE.MeshStandardMaterial[] = [];
  /**
   * Each material's emissive as BUILT, so the hit flash can be taken back off.
   *
   * The flash used to decay toward black, which is right for a body that has no
   * emissive of its own and wrong for every one that does — a beast body carries
   * glow parts (Lanternfin's lure, Umbrakit's wisps), and one sword hit would
   * otherwise put them out permanently. Restoring to what the builder wrote is
   * the only version of this that is correct for both.
   */
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
  /** Which way it swings around its quarry. */
  private wSpin = Math.random() < 0.5 ? -1 : 1;
  /** True while breaking off; false while closing. Starts closing. */
  private wCircling = false;
  /** Seconds left in the current phase. */
  private wPhaseT = WILD_PRESS_SECONDS[0] + Math.random() * WILD_PRESS_SECONDS[1];
  // gloopling
  private gAir = false;
  private gVy = 0;
  private gHopY = 0;
  private gRest = 0.4;
  private gSquash = 0;
  // snortle
  private state: 'roam' | 'windup' | 'charge' | 'recover' = 'roam';
  private stateT = 0;
  private phase = 0;
  private chargeCd = 2;
  private chargeDir = new THREE.Vector3();
  private dustT = 0;
  // peckit
  private pMode: 'cruise' | 'dive' | 'climb' = 'cruise';
  private orbitAngle = Math.random() * Math.PI * 2;
  private diveCd = 2 + Math.random() * 2;
  private divePoint = new THREE.Vector3();
  private diveHit = false;
  private flap = Math.random() * 10;

  // hp bar
  private barSprite: THREE.Sprite;
  private barMat: THREE.SpriteMaterial;
  private barTex: THREE.CanvasTexture;
  private barCtx: CanvasRenderingContext2D;
  private hpDirty = false;

  /**
   * `species` is a content id's name half and is resolved here.
   *
   * THROWS on a species this build has no asset for, and that is deliberate: the
   * only two callers are the spawner (which picks out of `enemySpecies()`, so it
   * cannot miss) and the lab's `?enemy=` (where a typo should say so). Every
   * other failure in the content layer degrades with a diagnostic because there
   * is something to degrade TO; an enemy with no stats is not one of those.
   */
  constructor(species: EnemySpeciesId, variantIdx: number, x: number, z: number, world: World) {
    this.species = species;
    const spec = speciesOf(species);
    if (!spec) throw new Error(`no enemy content for "${species}"`);
    const stats = spec.data;
    // EXACTLY THREE, in `variantForHeight` order — the content type refuses an
    // asset with any other number of palettes, so this index cannot be a hole.
    const variants = stats.variants;
    const v = variants[Math.min(variantIdx, variants.length - 1)];
    this.element = v.element;
    this.nameKey = spec.nameKey;
    this.xp = stats.xp;
    this.hp = stats.hp; this.maxHp = stats.hp;
    this.atk = stats.atk;
    this.speed = stats.speed;
    this.radius = stats.radius;
    this.height = stats.height;
    this.aggro = stats.aggro;
    this.palette = [v.main, v.dark, v.belly, v.accent];

    // WHICH BUILDER, BY NAME. The three-way ternary this replaces was the last
    // place a species id decided what to BUILD; the AI below still switches on
    // one, and deliberately — a Gloopling's hop, a Snortle's charge and a
    // Peckit's dive are three behaviours, and a behaviour is engine. The day
    // that becomes a factory kind of its own it will be for the same reason
    // this one is, and content will select it the same way.
    const body = spec.model(this.root, v);
    this.parts = body.parts;
    // A BEAST BODY POSES ITSELF. Everything else in this class switches on the
    // species id to pick an animation, and a wild beast cannot: its rig is one
    // of fifteen a companion wears and only that species knows how to move it.
    // So the three painted enemies keep their hand-written poses and a beast
    // gets `species.animate(rig, ctx)` — the same call BeastActor makes, through
    // the same clock. See `updateWildBeast`.
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
    // `flying` rather than the species name it used to test: a flyer starts in
    // the air because it is a flyer, and that is the field content states. The
    // one flyer in the roster is Peckit, so this is the same number it was.
    const startY = spec.flying ? Math.max(groundY, world.waterLevel) + 3.2 : groundY;
    this.root.position.set(x, startY, z);
    this.position = this.root.position;
    this.home.set(x, startY, z);
    this.goal.copy(this.home);
    this.root.rotation.y = Math.random() * Math.PI * 2;

    // billboard hp bar
    const canvas = document.createElement('canvas');
    canvas.width = 72; canvas.height = 10;
    this.barCtx = canvas.getContext('2d')!;
    this.barTex = new THREE.CanvasTexture(canvas);
    this.barTex.colorSpace = THREE.SRGBColorSpace;
    this.barMat = new THREE.SpriteMaterial({
      map: this.barTex, transparent: true, depthWrite: false, toneMapped: false,
    });
    this.barSprite = new THREE.Sprite(this.barMat);
    this.barSprite.scale.set(0.85, 0.13, 1);
    this.barSprite.renderOrder = 15;
    this.barSprite.visible = false;
    this.root.add(this.barSprite);
    this.barSprite.position.set(0, this.height + 0.4, 0);
    this.drawBar();
  }

  /**
   * INSIDE A TAMING ORB: off screen, out of the fight, and not yet gone.
   *
   * A THIRD STATE beside alive and dead, and it needs to be one because both of
   * the existing answers are wrong for two seconds. It is not dead — nothing
   * dropped, nobody got xp, and it may walk out of this — and it is not alive
   * either: it cannot bite, cannot be hit, and is not standing anywhere.
   *
   * Everything that acts on this enemy checks it in the one place that already
   * gates on `isDead`, so the ways a held beast could be interfered with are the
   * ways a dead one could be, and there is no fourth path to forget.
   */
  held = false;

  /**
   * May anything aim at, sweep over or splash this one?
   *
   * ONE PREDICATE for the seven scans in combat/index.ts that used to test
   * `isDead` alone. A held beast is invisible and refuses damage, so leaving
   * them on `isDead` would have been survivable for the DAMAGE — and not for the
   * aim assist, which would have quietly locked the crosshair onto an empty
   * patch of grass for two seconds. "Is it dead" and "may I aim at it" stopped
   * being the same question the moment there were three states.
   */
  get targetable(): boolean {
    return !this.isDead && !this.held;
  }

  setHeld(on: boolean): void {
    if (this.held === on) return;
    this.held = on;
    this.root.visible = !on;
    // The bar is a separate `visible` and would otherwise hang in the air over
    // an empty patch of grass for the whole ceremony.
    this.barSprite.visible = !on && this.hp < this.maxHp;
    if (!on) {
      // It came back out. Provoked, because being shut in a jar is something
      // that happened TO it — a beast that broke free and then ambled off to
      // eat grass reads as the game having forgotten.
      this.provoked = true;
      this.atkCd = Math.max(this.atkCd, 0.6);
    }
  }

  takeDamage(amount: number, from: THREE.Vector3, _element?: ElementType): boolean {
    if (this.isDead || this.held) return false;
    this.hp -= amount;
    this.hpDirty = true;
    this.flashT = 0.14;
    this.provoked = true;
    const knockMul = this.species === 'snortle' ? 1.4 : 3.4;
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
    ctx.fillStyle = 'rgba(8,10,16,0.82)';
    ctx.fillRect(0, 0, 72, 10);
    const p = Math.max(0, this.hp / this.maxHp);
    const hue = 6 + 108 * p;
    ctx.fillStyle = `hsl(${hue}, 85%, 52%)`;
    ctx.fillRect(1.5, 1.5, 69 * p, 7);
    this.barTex.needsUpdate = true;
  }

  /**
   * Pick a target, and decide when to give one up.
   *
   * DELIBERATELY HORIZONTAL, both for acquiring and for the leash — unlike the
   * melee strike tests, which now carry a vertical cap (see MELEE_UP_REACH).
   * Noticing you and being able to bite you are different questions: a monster
   * that forgets you the instant you step on a rock is broken in the other
   * direction, and the honest fantasy of scrambling up a tree is that the thing
   * below mills around waiting for you, not that it shrugs and wanders off. So
   * an enemy under a climber keeps chasing, keeps facing, keeps charging past —
   * and simply lands nothing until you come down.
   *
   * The leash was previously a 3D `distanceTo`, which meant altitude alone could
   * spend the aggro budget (a hero 20 units up a trunk read as 20 units away).
   * It is horizontal now so that the only thing which drops a target is walking
   * away from it, which is the rule the numbers were tuned for.
   */
  private retarget(ctx: EnemyCtx): void {
    this.retargetT -= 0.0166;
    if (this.retargetT > 0) return;
    this.retargetT = 0.22;
    const range = this.provoked ? 26 : this.aggro;
    let best: Damageable | null = null;
    let bd = range * range;
    for (const t of ctx.targets) {
      if (t.isDead) continue;
      const dx = t.position.x - this.position.x;
      const dz = t.position.z - this.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; best = t; }
    }
    if (best) {
      this.target = best;
    } else if (this.target) {
      const dx = this.target.position.x - this.position.x;
      const dz = this.target.position.z - this.position.z;
      const leash = this.aggro * 2.2;
      if (this.target.isDead || dx * dx + dz * dz > leash * leash) {
        this.target = null; this.provoked = false;
      }
    }
  }

  /**
   * Vertical half of a ground melee test — see MELEE_UP_REACH.
   *
   * Called by every contact/charge/shove strike AFTER the horizontal radius
   * check has passed, so the pair together describe a squat cylinder around the
   * attacker rather than the infinite column the code used to have.
   */
  private inMeleeHeight(t: Damageable): boolean {
    return inRise(this.position.y, t.position.y, MELEE_UP_REACH, MELEE_DOWN_REACH);
  }

  private faceToward(x: number, z: number, dt: number, rate: number): void {
    const want = Math.atan2(x - this.position.x, z - this.position.z);
    let d = want - this.root.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.root.rotation.y += d * Math.min(1, rate * dt);
  }

  /**
   * Where to amble next — and the OTHER half of the safe-zone rule.
   *
   * A zone forbids the two ways a hostile reaches a settlement without the
   * player being involved, and refusing to spawn there is only the first: an
   * animal that appeared eight units outside the gate and wanders in a 2-8 unit
   * circle around where it started walks into the camp on its own. So a goal
   * inside a zone is refused exactly as a goal in the water already is, and by
   * the same fallback — walk home.
   *
   * NOTHING HERE TOUCHES A CHASE. `this.target` is read by the callers, above
   * this function, and a hunting enemy never asks for a wander goal at all —
   * which is the requirement: being chased through the gate and down the high
   * street is the fantasy the zone exists to leave intact. Home is likewise
   * never re-tested, so an enemy that a designer's zone was later drawn around
   * mills about where it stands instead of being teleported or stranded.
   */
  private pickWanderGoal(ctx: EnemyCtx): void {
    const a = Math.random() * Math.PI * 2;
    const r = 2 + Math.random() * 6;
    const gx = this.home.x + Math.cos(a) * r;
    const gz = this.home.z + Math.sin(a) * r;
    if (this.species !== 'peckit' && ctx.world.isWater(gx, gz)) {
      this.goal.copy(this.home);
    } else if (ctx.world.safeZones.blocksSpawn(gx, gz)) {
      this.goal.copy(this.home);
    } else {
      this.goal.set(gx, 0, gz);
    }
  }

  update(dt: number, ctx: EnemyCtx): void {
    if (this.isDead || this.held) return;
    // THE GROUND MOVES FIRST — the same line the hero, the saddle and a
    // follower open with. A wild thing that wandered onto a flying island (or,
    // more usually, one that chased the player onto one) travels with it; the
    // issue asks for flying mobs too, and a Peckit's cruise altitude is
    // measured off `groundAt`, so it circles the deck rather than the meadow
    // eighty units under it.
    //
    // `home` is deliberately NOT carried. It is where the thing came from, in
    // world space, and it is what the leash pulls it back to — an aggressive
    // spawn that followed the player onto a departing island should want to go
    // home, which is the behaviour that stops the world's wildlife accumulating
    // on the one piece of it that moves.
    this.ride.carry(ctx.world, this.position);
    if (this.ride.dyaw !== 0) this.root.rotation.y += this.ride.dyaw;
    this.retarget(ctx);
    this.atkCd -= dt;

    // A BEAST BODY FIRST, because the three tests below are on a species ID and
    // a wild beast's id is whatever the asset was called — `else` would send a
    // wild Sproutle into Peckit's dive and pose parts it does not have.
    if (this.beastSpecies) this.updateWildBeast(dt, ctx);
    else if (this.species === 'gloopling') this.updateGloopling(dt, ctx);
    else if (this.species === 'snortle') this.updateSnortle(dt, ctx);
    else this.updatePeckit(dt, ctx);

    // knockback
    if (this.knock.lengthSq() > 0.001) {
      this.position.x += this.knock.x * dt;
      this.position.z += this.knock.z * dt;
      const d = Math.exp(-6 * dt);
      this.knock.multiplyScalar(d);
    }

    // Hit flash, ADDED to what the builder wrote rather than replacing it — see
    // `baseEmissive`. The last write of the ramp is f = 0, which is what puts a
    // glowing part back exactly as it was instead of leaving it dark.
    if (this.flashT > 0) {
      this.flashT -= dt;
      const f = Math.max(0, this.flashT / 0.14) * 0.9;
      for (let i = 0; i < this.mats.length; i++) {
        const b = this.baseEmissive[i];
        this.mats[i].emissive.setRGB(b.r + f, b.g + f, b.b + f);
      }
    }

    // hp bar
    if (this.hpDirty) {
      this.hpDirty = false;
      this.drawBar();
      this.barSprite.visible = this.hp < this.maxHp;
    }
  }

  /**
   * Move horizontally, refusing to walk into water or into a building (ground
   * species).
   *
   * Both refusals are all-or-nothing rather than per-axis, and that is the
   * existing shape rather than a new decision: an enemy that meets a shoreline
   * has always simply stopped. What it must not do is stand inside a hut wall
   * the player is pressed against from the other side, which is why the
   * structure test is here and uses the hero's own MAX_STEP_UP — a wild pack
   * should be stopped by exactly the things that stop him, and step over
   * exactly the things he steps over.
   */
  /**
   * What this thing walks on: the terrain, or the deck of whatever is carrying
   * it. -Infinity from the ride unless it is actually riding one, so everywhere
   * else in the world this is `getHeight` and nothing else.
   *
   * The same shape as `BeastActor.groundAt` and for the same reason: a deck IS
   * the ground, where a settlement is a thing standing on it — which is why
   * this folds in a carrier and not `structureTopAt`.
   */
  private groundAt(ctx: EnemyCtx, x: number, z: number): number {
    const g = ctx.world.getHeight(x, z);
    const deck = this.ride.support(x, z);
    return deck > g ? deck : g;
  }

  private moveGround(dt: number, dirX: number, dirZ: number, spd: number, ctx: EnemyCtx): void {
    const nx = this.position.x + dirX * spd * dt;
    const nz = this.position.z + dirZ * spd * dt;
    if (ctx.world.isWater(nx, nz)) return;
    if (ctx.world.structureTopAt(nx, nz) > this.position.y + MAX_STEP_UP) return;
    this.position.x = nx;
    this.position.z = nz;
  }

  // ------------------------------------------------------------ wild beast
  /**
   * Swap press for circle, or back, and roll the next phase's length.
   *
   * Called on a timer AND on a landed bite, which is why the caller sets
   * `wCircling` rather than this reading it: "a bite ends the press" and "the
   * press ran out" are the same transition and get the same fresh roll.
   */
  private nextWildPhase(): void {
    this.wCircling = !this.wCircling;
    const [base, spread] = this.wCircling ? WILD_CIRCLE_SECONDS : WILD_PRESS_SECONDS;
    this.wPhaseT = base + Math.random() * spread;
    if (this.wCircling && Math.random() < WILD_SPIN_FLIP) this.wSpin = -this.wSpin as 1 | -1;
  }

  /**
   * A WILD ONE OF THE COMPANION SPECIES: walk, chase, bite — and let the species
   * pose itself.
   *
   * THE FOURTH BEHAVIOUR, AND DELIBERATELY THE PLAINEST. The other three are
   * characters: a Gloopling hops, a Snortle winds up and charges, a Peckit dives
   * out of the sky, and each one's movement and its animation are the same
   * fifteen lines because the hop IS the squash. A beast is the opposite case —
   * fifteen different bodies share this one AI, and none of their poses are
   * written here at all. So this steers, and `species.animate` performs.
   *
   * WHY NOT REUSE `BeastActor`. A companion follows an owner, teleports when it
   * falls behind, revives after eight seconds and runs errands; none of that is
   * what a wild animal does, and the half of it that IS shared — the rig, the
   * phase integrator, the pose call — is now shared, through `BeastAnimClock`.
   * What is left is a wander and a chase, which is this function.
   *
   * GROUND OR AIR off `spec.flying`, the same field the spawn height reads.
   * A flyer holds a cruise altitude over whatever is under it (terrain or a
   * carrier's deck) and stoops to bite; a walker resolves its feet against the
   * same column every other mover in the game does.
   */
  private updateWildBeast(dt: number, ctx: EnemyCtx): void {
    const species = this.beastSpecies!;
    const rig = this.beastRig!;
    const clock = this.beastClock!;
    const flying = species.locomotion === 'flying';

    // How close is close enough to stop walking. The bite radius plus a body,
    // so it comes to rest at arm's length instead of standing inside you.
    const stopAt = this.radius + 0.9;
    const chasing = this.target !== null;
    /**
     * How hard the steer below is pulling, 0..1 — and therefore how fast to
     * walk it. A beast already sitting on its ring is steering with the tangent
     * alone, and running that at the closing sprint would spin it around the
     * hero like a fairground ride. Scaling the speed by the steer instead turns
     * the settled press into a prowl and leaves the break-off at full pelt.
     */
    let urge = 1;

    // Where it wants to be. A target is CIRCLED — see the WILD_RING_OUT block;
    // otherwise it ambles between wander goals, which is `pickWanderGoal`'s
    // existing safe-zone-respecting pick — a wild beast must not stroll into a
    // settlement any more than a Gloopling may.
    if (this.target) {
      this.wPhaseT -= dt;
      if (this.wPhaseT <= 0) this.nextWildPhase();
      const t = this.target.position;
      // TWO AXES, NOT A POINT ON A RING. Aiming at a spot leaned around the
      // ring looks right and measures wrong: the lean is nearly all tangent, so
      // the beast races around the quarry and gains almost no distance —
      // measured, a break-off with a 3.6-unit ring moved it 0.7 units out and
      // the fight still read as welded. Steering RADIALLY toward the ring and
      // TANGENTIALLY around it, and blending the two, is the same orbit with
      // the radius under control: far out it is a beeline, at the ring it is a
      // circle, and the break-off is a real one.
      let ox = this.position.x - t.x;
      let oz = this.position.z - t.z;
      const cur = Math.hypot(ox, oz) || 1e-4;
      ox /= cur; oz /= cur;
      const ring = stopAt + (this.wCircling ? WILD_RING_OUT : 0);
      // Full radial commitment 1.5 units off the ring, easing to nothing at it,
      // so the beast settles onto the ring instead of oscillating across it.
      const radial = Math.max(-1, Math.min(1, (ring - cur) / 1.5));
      const tang = this.wSpin * (this.wCircling ? WILD_LEAN_CIRCLE : WILD_LEAN_PRESS);
      const gx = ox * radial - oz * tang;
      const gz = oz * radial + ox * tang;
      // A goal two units along the steer, because everything below this reads a
      // POINT — it is a heading expressed in the shape the mover already takes.
      const gl = Math.hypot(gx, gz) || 1e-4;
      urge = Math.min(1, gl);
      this.goal.set(
        this.position.x + (gx / gl) * 2, 0,
        this.position.z + (gz / gl) * 2,
      );
    } else {
      this.wanderT -= dt;
      if (this.wanderT <= 0) {
        this.wanderT = 2 + Math.random() * 3;
        this.pickWanderGoal(ctx);
      }
    }

    _dir.set(this.goal.x - this.position.x, 0, this.goal.z - this.position.z);
    const dist = _dir.length();
    if (dist > 0.01) _dir.divideScalar(dist);

    // A CHASER'S GOAL IS ALREADY THE STANDOFF POINT, so it walks all the way to
    // it; only a wanderer stops a body short of the spot it picked.
    const stopShort = chasing ? 0.35 : stopAt;
    // Closing is the sprint it always was; a break-off is a lope, so the swing
    // reads as circling rather than as the same run on a curve.
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
    // FACE THE QUARRY, NEVER THE GOAL. The goal is off to one side now, and a
    // beast that aimed its nose at it would sidle around the fight looking away
    // from the thing it is fighting.
    if (chasing) this.faceToward(this.target!.position.x, this.target!.position.z, dt, 8);
    else if (moved > 0) this.faceToward(this.goal.x, this.goal.z, dt, 7);

    // Feet. A walker sits on the column; a flyer holds CRUISE_RISE over it and
    // drops toward its quarry's own height while hunting, so a bite is possible
    // at all — the melee band below is 1.5 units up and 2.5 down, and a beast
    // cruising four units over the meadow could never reach anything.
    const groundY = this.groundAt(ctx, this.position.x, this.position.z);
    const wantY = flying
      ? (chasing
        ? Math.max(groundY + 0.6, this.target!.position.y + 0.9)
        : Math.max(groundY, ctx.world.waterLevel) + WILD_FLY_RISE)
      : groundY;
    this.position.y += (wantY - this.position.y) * Math.min(1, (flying ? 3.5 : 14) * dt);

    // The bite. Same shape as the Gloopling's contact attack, including the
    // vertical cap — a wild beast standing under a climber waits for him rather
    // than reaching up a tree.
    if (this.target && this.atkCd <= 0 && !this.target.isDead) {
      const dx = this.target.position.x - this.position.x;
      const dz = this.target.position.z - this.position.z;
      if (dx * dx + dz * dz < (this.radius + 1.0) ** 2 && this.inMeleeHeight(this.target)) {
        ctx.hit(this.target, this.atk, this.element, this.position.x, this.position.y + this.height * 0.5, this.position.z);
        this.atkCd = WILD_BITE_CD[0] + Math.random() * WILD_BITE_CD[1];
        this.beastAction = 'attack';
        this.beastActionT = 0;
        // BREAK OFF ON A LANDED BITE. This is the half of #111 a player feels
        // first: the animal that just bit you gives ground instead of standing
        // in your face waiting out its cooldown.
        this.wCircling = false;   // so nextWildPhase() turns it on
        this.nextWildPhase();
      }
    }

    // POSE. `moveSpeed` is normalised against the beast's own base speed rather
    // than against the content `speed` it is walking at, because that is what a
    // species' gait blend is authored against (see BeastAnimCtx.moveSpeed) — a
    // rig whose walk cycle is calibrated for 3.4 units/s must not run flat out
    // because an asset said 2.2.
    this.beastActionT += dt;
    const attacking = this.beastAction === 'attack' && this.beastActionT < WILD_ATTACK_SECONDS;
    if (!attacking) this.beastAction = 'idle';
    const base = species.baseStats.speed;
    const speed01 = base > 0 ? Math.min(1, moved / base) : 0;
    const gait: BeastAction = flying ? 'fly'
      : moved <= 0.01 ? 'idle'
      : chasing ? 'run' : 'walk';
    const c = clock.ctx;
    // The free-running clock species read for breathing and ear flicks. It
    // advances every slice whatever the action is; `actionTime` is the separate
    // "how long have I been doing THIS" a transient pose reads.
    c.time += dt;
    c.action = attacking ? 'attack' : gait;
    c.actionTime = attacking ? this.beastActionT : c.time;
    c.moveSpeed = speed01;
    c.dt = dt;
    // Same contract the companion framework fills — a wild flyer's contact blob
    // belongs on the ground under it, not at a fixed drop below its belly.
    c.altitude = Math.max(
      0, this.position.y - Math.max(groundY, ctx.world.waterLevel),
    );
    species.animate(rig, c);
  }

  // ------------------------------------------------------------ gloopling
  private updateGloopling(dt: number, ctx: EnemyCtx): void {
    const body = this.parts.body;
    const groundY = this.groundAt(ctx, this.position.x, this.position.z);
    this.position.y += (groundY - this.position.y) * Math.min(1, 14 * dt);

    if (!this.gAir) {
      this.gRest -= dt;
      this.gSquash *= Math.exp(-8 * dt);
      if (this.gRest <= 0) {
        if (this.target) this.goal.copy(this.target.position);
        else {
          this.wanderT -= dt + 0.3;
          if (this.wanderT <= 0) { this.wanderT = 1 + Math.random() * 2; this.pickWanderGoal(ctx); }
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

    // squash & stretch + idle breathing
    const breathe = Math.sin(ctx.time * 3.2 + this.seed) * 0.03;
    const sq = this.gAir ? -0.2 : this.gSquash;
    body.scale.set(1 + sq * 0.5 + breathe, 1 - sq * 0.55 - breathe, 1 + sq * 0.5 + breathe);
    body.position.y = this.gHopY;

    // Contact attack. Horizontal radius as tuned, plus the vertical cap: a
    // hopping blob touches what is beside it, not what is up a tree.
    if (this.target && this.atkCd <= 0 && !this.target.isDead) {
      const dx = this.target.position.x - this.position.x;
      const dz = this.target.position.z - this.position.z;
      if (dx * dx + dz * dz < (this.radius + 0.8) ** 2 && this.inMeleeHeight(this.target)) {
        ctx.hit(this.target, this.atk, this.element, this.position.x, this.position.y + 0.4, this.position.z);
        this.atkCd = 1.3;
        this.knock.set(-dx, 0, -dz).normalize().multiplyScalar(2.2);
      }
    }
  }

  // -------------------------------------------------------------- snortle
  private updateSnortle(dt: number, ctx: EnemyCtx): void {
    const head = this.parts.head;
    const body = this.parts.body;
    const groundY = this.groundAt(ctx, this.position.x, this.position.z);
    this.position.y += (groundY - this.position.y) * Math.min(1, 14 * dt);
    this.chargeCd -= dt;

    let moveAmt = 0;
    switch (this.state) {
      case 'roam': {
        if (this.target) {
          _dir.set(this.target.position.x - this.position.x, 0, this.target.position.z - this.position.z);
          const dist = _dir.length();
          if (dist > 0.01) _dir.divideScalar(dist);
          if (this.chargeCd <= 0 && dist > 2.6 && dist < 8.5) {
            this.state = 'windup';
            this.stateT = 0.55;
            break;
          }
          // `dist` is HORIZONTAL by construction (_dir was built with y = 0),
          // which is what steering wants — keep walking under a target that is
          // above you. Only the shove is gated on height.
          if (dist > this.radius + 0.9) {
            this.moveGround(dt, _dir.x, _dir.z, this.speed, ctx);
            moveAmt = this.speed;
          } else if (this.atkCd <= 0 && !this.target.isDead && this.inMeleeHeight(this.target)) {
            // close-range shove
            ctx.hit(this.target, this.atk * 0.6, this.element, this.position.x, this.position.y + 0.6, this.position.z);
            this.atkCd = 1.1;
          }
          this.faceToward(this.target.position.x, this.target.position.z, dt, 9);
        } else {
          this.wanderT -= dt;
          if (this.wanderT <= 0) { this.wanderT = 2.5 + Math.random() * 3; this.pickWanderGoal(ctx); }
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
      case 'windup': {
        this.stateT -= dt;
        if (this.target) this.faceToward(this.target.position.x, this.target.position.z, dt, 10);
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
            this.chargeDir.set(
              this.target.position.x - this.position.x, 0,
              this.target.position.z - this.position.z).normalize();
          } else {
            this.chargeDir.set(Math.sin(this.root.rotation.y), 0, Math.cos(this.root.rotation.y));
          }
          this.state = 'charge';
          this.stateT = 1.0;
        }
        break;
      }
      case 'charge': {
        this.stateT -= dt;
        head.rotation.x = 0.42;
        head.rotation.z = 0;
        const nx = this.position.x + this.chargeDir.x * 8.5 * dt;
        const nz = this.position.z + this.chargeDir.z * 8.5 * dt;
        // A charge does not go through `moveGround`, so it repeats both of that
        // method's refusals — and a snortle that slams into a palisade breaking
        // off into 'recover' is the right answer anyway.
        if (ctx.world.isWater(nx, nz)
          || ctx.world.structureTopAt(nx, nz) > this.position.y + MAX_STEP_UP) {
          this.state = 'recover'; this.stateT = 0.8; this.chargeCd = 3.5;
          break;
        }
        this.position.x = nx; this.position.z = nz;
        moveAmt = 8.5;
        this.faceToward(this.position.x + this.chargeDir.x, this.position.z + this.chargeDir.z, dt, 30);
        this.dustT -= dt;
        if (this.dustT <= 0) {
          this.dustT = 0.05;
          ctx.vfx.dust(this.position.x, this.position.y + 0.05, this.position.z, 2);
        }
        // Hit anything in the way — "in the way" meaning at roughly this
        // animal's own altitude. A charge is a ground lunge; it ploughs through
        // whatever is standing on the floor and passes harmlessly under
        // anything on a ledge or up a trunk.
        for (const t of ctx.targets) {
          if (t.isDead) continue;
          const dx = t.position.x - this.position.x;
          const dz = t.position.z - this.position.z;
          if (dx * dx + dz * dz < (this.radius + 0.85) ** 2 && this.inMeleeHeight(t)) {
            ctx.hit(t, this.atk * 1.5, this.element, this.position.x, this.position.y + 0.6, this.position.z);
            this.state = 'recover'; this.stateT = 0.9; this.chargeCd = 3.5;
            break;
          }
        }
        if (this.state === 'charge' && this.stateT <= 0) {
          this.state = 'recover'; this.stateT = 0.7; this.chargeCd = 3.2;
        }
        break;
      }
      case 'recover': {
        this.stateT -= dt;
        head.rotation.x = -0.12;
        if (this.stateT <= 0) this.state = 'roam';
        break;
      }
    }

    // gait animation
    const gait = Math.min(1, moveAmt / this.speed);
    this.phase += moveAmt * dt * 3.4;
    const swing = Math.sin(this.phase) * 0.6 * Math.max(0.15, gait);
    (this.parts.legFL as THREE.Group).rotation.x = swing;
    (this.parts.legBR as THREE.Group).rotation.x = swing;
    (this.parts.legFR as THREE.Group).rotation.x = -swing;
    (this.parts.legBL as THREE.Group).rotation.x = -swing;
    body.position.y = 0.30 + Math.abs(Math.sin(this.phase)) * 0.035 * gait;
    body.rotation.z = Math.sin(this.phase) * 0.04 * gait;
  }

  // --------------------------------------------------------------- peckit
  private updatePeckit(dt: number, ctx: EnemyCtx): void {
    const body = this.parts.body;
    const head = this.parts.head;
    const wingL = this.parts.wingL;
    const wingR = this.parts.wingR;
    const groundY = Math.max(
      this.groundAt(ctx, this.position.x, this.position.z), ctx.world.waterLevel,
    );
    const cruiseY = groundY + 3.3 + Math.sin(ctx.time * 0.9 + this.seed) * 0.35;
    this.diveCd -= dt;

    if (this.pMode === 'cruise') {
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
      if (dist > 0.01) _dir.divideScalar(dist);
      _dir.multiplyScalar(Math.min(this.speed, dist * 3));
      this.vel.lerp(_dir, Math.min(1, 3.5 * dt));
      if (this.target && this.diveCd <= 0 && !this.target.isDead) {
        const dx = this.target.position.x - this.position.x;
        const dz = this.target.position.z - this.position.z;
        if (dx * dx + dz * dz < 144) {
          this.pMode = 'dive';
          this.divePoint.copy(this.target.position);
          this.divePoint.y += 0.8;
          this.stateT = 1.6;
          this.diveHit = false;
        }
      }
    } else if (this.pMode === 'dive') {
      this.stateT -= dt;
      _dir.copy(this.divePoint).sub(this.position);
      const dist = _dir.length();
      if (dist > 0.01) _dir.divideScalar(dist);
      this.vel.lerp(_tmp.copy(_dir).multiplyScalar(11), Math.min(1, 8 * dt));
      ctx.vfx.trail(this.position.x, this.position.y + 0.35, this.position.z, 0xd8ecff, 0.11);
      // NOT gated by MELEE_UP_REACH, on purpose: this is already a true 3D
      // proximity test, and Peckit is a flyer whose whole attack is arriving
      // from a different altitude. A dive that could not reach a hero on a
      // branch would be the opposite bug.
      if (this.target && !this.diveHit && !this.target.isDead) {
        const d2 = _tmp.copy(this.target.position).setY(this.target.position.y + 0.8).distanceToSquared(this.position);
        if (d2 < 1.9) {
          ctx.hit(this.target, this.atk, this.element, this.position.x, this.position.y, this.position.z);
          this.diveHit = true;
        }
      }
      if (dist < 1.0 || this.stateT <= 0 || this.diveHit) {
        this.pMode = 'climb';
        this.stateT = 1.2;
        this.diveCd = 3.2 + Math.random() * 1.6;
      }
    } else {
      // climb
      this.stateT -= dt;
      _dir.set(this.vel.x, 0, this.vel.z);
      if (_dir.lengthSq() < 0.5) _dir.set(Math.sin(this.root.rotation.y), 0, Math.cos(this.root.rotation.y));
      _dir.normalize();
      _tmp.set(_dir.x * 4, 5, _dir.z * 4);
      this.vel.lerp(_tmp, Math.min(1, 4 * dt));
      if (this.position.y >= cruiseY - 0.3 || this.stateT <= 0) this.pMode = 'cruise';
    }

    this.position.addScaledVector(this.vel, dt);
    if (this.position.y < groundY + 0.7) this.position.y = groundY + 0.7;

    // orientation + flapping
    const hspd = Math.sqrt(this.vel.x * this.vel.x + this.vel.z * this.vel.z);
    if (hspd > 0.4) this.faceToward(this.position.x + this.vel.x, this.position.z + this.vel.z, dt, 8);
    body.rotation.x = Math.max(-0.8, Math.min(0.8, Math.atan2(-this.vel.y, Math.max(1.5, hspd)) * 0.8));
    this.flap += dt * (this.pMode === 'climb' ? 17 : this.pMode === 'dive' ? 4 : 11);
    const flapAng = this.pMode === 'dive' ? 0.32 : Math.sin(this.flap) * 0.85 - 0.1;
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
        if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
        else m.dispose();
      }
    });
    this.barTex.dispose();
    this.barMat.dispose();
  }
}

// ---------------------------------------------------------------------------
// The model registry
// ---------------------------------------------------------------------------

/**
 * The voxel builders a species' `model` field may select.
 *
 * ONE PLACE A BUILDER IS NAMED, for the same reason `NPC_BODIES` is one place a
 * character body is: the registration loop reads this map, so a builder cannot
 * be written and left unregistered, or registered under a name nothing builds.
 */
const MODELS: ReadonlyMap<string, EnemyModel> = new Map<string, EnemyModel>([
  ['gloopling', buildGloopling],
  ['snortle', buildSnortle],
  ['peckit', buildPeckit],
]);

/**
 * Published at module load, which is before `bootstrapContent()` — every module
 * body is evaluated before main.ts's own runs. Registering also tells the enemy
 * content type which names exist, so `"model": "gloopling "` is an
 * `unknown-factory` finding on the field that holds it rather than a builder
 * lookup that comes back undefined inside a spawn. See src/content/index.ts.
 */
for (const [name, model] of MODELS) defineFactory(ENEMY_MODEL_KIND, name, model);

/**
 * ONE MORE BUILDER PER COMPANION SPECIES — the wild half of the roster.
 *
 * `enemy-model/beast-sproutle` builds the same rig `BeastActor` wears, so a wild
 * Sproutle and the one that follows you home are the same animal by
 * construction. That is the whole reason bonding can hand the player a species
 * without a mapping table: what you fought is what you get.
 *
 * DERIVED FROM `ALL_SPECIES` rather than listed, unlike `MODELS` above, and the
 * difference is which way the duplication would run. A hand-written map of the
 * three painted enemies is the one place their builders are named; a hand-written
 * map of fifteen beast bodies would be a SECOND list of the species the game has,
 * which is exactly what src/beasts/registry.ts exists to be the only copy of.
 *
 * THE PALETTE IS IGNORED, and it has to be: a beast's colours are painted into
 * its own rig by its own species file, where a Gloopling's are content. The three
 * variants an asset still carries are read for `element` and for the death
 * debris, which is why the parameter is dropped here and not removed there.
 */
for (const sp of ALL_SPECIES) {
  const build: EnemyModel = (root) => {
    const rig = sp.buildRig();
    root.add(rig.root);
    return { parts: rig.parts, beast: { species: sp, rig } };
  };
  defineFactory(ENEMY_MODEL_KIND, BEAST_MODEL_PREFIX + sp.id, build);
}
