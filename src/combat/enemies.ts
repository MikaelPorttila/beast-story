import * as THREE from 'three';
import { VoxelModel, shade } from '../core/voxel';
import type { Damageable, ElementType, World } from '../core/types';
import type { VFX } from './vfx';

/**
 * Wild enemies: three voxel species with biome palette variants, terrain-aware
 * AI (idle / wander / aggro / attack), billboard hp bars, white hit-flash and
 * knockback. Death VFX + drops are orchestrated by CombatSystem.
 */

export type EnemySpeciesId = 'gloopling' | 'snortle' | 'peckit';

export interface EnemyCtx {
  world: World;
  targets: readonly Damageable[];
  vfx: VFX;
  time: number;
  hit(target: Damageable, amount: number, element: ElementType, fromX: number, fromY: number, fromZ: number): void;
}

export const ENEMY_DEFS: ReadonlyArray<{ id: EnemySpeciesId; flying: boolean }> = [
  { id: 'gloopling', flying: false },
  { id: 'snortle', flying: false },
  { id: 'peckit', flying: true },
];

/** Pick a palette variant from height above water: 0 = mid, 1 = highland, 2 = lowland. */
export function variantForHeight(dh: number): number {
  if (dh < 2.5) return 2;
  if (dh > 11) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Palettes
// ---------------------------------------------------------------------------
interface Variant {
  element: ElementType;
  main: number; dark: number; belly: number; accent: number;
}

const GLOOP_VARIANTS: readonly Variant[] = [
  { element: 'grass', main: 0x6fd84f, dark: 0x47a833, belly: 0xbdf29c, accent: 0x1c3a14 },
  { element: 'shadow', main: 0xa06ce0, dark: 0x7245b0, belly: 0xd9b8ff, accent: 0x2c1450 },
  { element: 'water', main: 0x3fb2f2, dark: 0x2a84c6, belly: 0xa8e8ff, accent: 0x0d2c48 },
];

const SNORTLE_VARIANTS: readonly Variant[] = [
  { element: 'rock', main: 0x9a6a42, dark: 0x6b4628, belly: 0xc99e6f, accent: 0xe6ab7c },
  { element: 'ice', main: 0x8fa8c0, dark: 0x5a728c, belly: 0xdae8f4, accent: 0xc4d6e8 },
  { element: 'fire', main: 0xd4593a, dark: 0x8e3021, belly: 0xf2a468, accent: 0xf6c290 },
];

const PECKIT_VARIANTS: readonly Variant[] = [
  { element: 'wind', main: 0x3c4454, dark: 0x242a36, belly: 0x5e6e84, accent: 0xf0a032 },
  { element: 'shadow', main: 0x4a3d74, dark: 0x2c2148, belly: 0x7159a6, accent: 0xffd23f },
  { element: 'electric', main: 0xc08a3c, dark: 0x7c5522, belly: 0xe9d092, accent: 0x5a626e },
];

interface SpeciesStats {
  name: string; hp: number; atk: number; speed: number; xp: number;
  radius: number; height: number; aggro: number;
}

const STATS: Record<EnemySpeciesId, SpeciesStats> = {
  gloopling: { name: 'Gloopling', hp: 32, atk: 6, speed: 2.3, xp: 8, radius: 0.5, height: 0.95, aggro: 9 },
  snortle: { name: 'Snortle', hp: 62, atk: 11, speed: 2.9, xp: 16, radius: 0.62, height: 1.15, aggro: 10 },
  peckit: { name: 'Peckit', hp: 26, atk: 9, speed: 5.2, xp: 12, radius: 0.45, height: 0.8, aggro: 12 },
};

// ---------------------------------------------------------------------------
// Voxel builders
// ---------------------------------------------------------------------------
function buildGloopling(root: THREE.Group, v: Variant): Record<string, THREE.Object3D> {
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
  return { body };
}

function buildSnortle(root: THREE.Group, v: Variant): Record<string, THREE.Object3D> {
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
  return parts;
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

function buildPeckit(root: THREE.Group, v: Variant): Record<string, THREE.Object3D> {
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

  return { body, head, wingL, wingR };
}

// ---------------------------------------------------------------------------
// Melee reach in the vertical
// ---------------------------------------------------------------------------
/**
 * How far a GROUND melee attack may reach above and below the attacker's own
 * feet. Both `position.y` values compared are feet (an enemy is pinned to
 * `world.getHeight`, the hero's origin is his soles), so these are feet-to-feet.
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
 */
const MELEE_UP_REACH = 1.5;
const MELEE_DOWN_REACH = 2.5;

// TEMP INSTRUMENTATION — remove before finishing.
const _ms = {
  tried: 0, landed: 0, blocked: 0, maxDy: 0,
  hitGloopling: 0, hitSnortle: 0, hitPeckit: 0,
};
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__dbgMelee = () => ({ ..._ms });
  (window as unknown as Record<string, unknown>).__dbgMeleeReset = () => {
    _ms.tried = 0; _ms.landed = 0; _ms.blocked = 0; _ms.maxDy = 0;
    _ms.hitGloopling = 0; _ms.hitSnortle = 0; _ms.hitPeckit = 0;
  };
}
const _live = new Set<Enemy>();
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__dbgEnemies = () => [..._live].map((e) => ({
    species: e.species, hp: e.hp, dead: e.isDead, hasTarget: !!e.target,
    x: +e.position.x.toFixed(2), y: +e.position.y.toFixed(2), z: +e.position.z.toFixed(2),
  }));
}
function _mshit(s: EnemySpeciesId): void {
  if (s === 'gloopling') _ms.hitGloopling++;
  else if (s === 'snortle') _ms.hitSnortle++;
  else _ms.hitPeckit++;
}

// ---------------------------------------------------------------------------
// Enemy
// ---------------------------------------------------------------------------
const _dir = new THREE.Vector3();
const _tmp = new THREE.Vector3();

export class Enemy implements Damageable {
  readonly position: THREE.Vector3;
  hp: number;
  maxHp: number;
  isDead = false;
  readonly faction = 'wild' as const;

  readonly root = new THREE.Group();
  readonly parts: Record<string, THREE.Object3D>;
  readonly element: ElementType;
  readonly name: string;
  readonly xp: number;
  readonly radius: number;
  readonly height: number;
  readonly palette: readonly number[];
  readonly species: EnemySpeciesId;

  private mats: THREE.MeshStandardMaterial[] = [];
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

  constructor(species: EnemySpeciesId, variantIdx: number, x: number, z: number, world: World) {
    this.species = species;
    const stats = STATS[species];
    const variants = species === 'gloopling' ? GLOOP_VARIANTS : species === 'snortle' ? SNORTLE_VARIANTS : PECKIT_VARIANTS;
    const v = variants[Math.min(variantIdx, variants.length - 1)];
    this.element = v.element;
    this.name = stats.name;
    this.xp = stats.xp;
    this.hp = stats.hp; this.maxHp = stats.hp;
    this.atk = stats.atk;
    this.speed = stats.speed;
    this.radius = stats.radius;
    this.height = stats.height;
    this.aggro = stats.aggro;
    this.palette = [v.main, v.dark, v.belly, v.accent];

    this.parts =
      species === 'gloopling' ? buildGloopling(this.root, v) :
      species === 'snortle' ? buildSnortle(this.root, v) :
      buildPeckit(this.root, v);

    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && (mesh.material as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
        this.mats.push(mesh.material as THREE.MeshStandardMaterial);
      }
    });

    const groundY = world.getHeight(x, z);
    const startY = species === 'peckit' ? Math.max(groundY, world.waterLevel) + 3.2 : groundY;
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
    _live.add(this);
  }

  takeDamage(amount: number, from: THREE.Vector3, _element?: ElementType): void {
    if (this.isDead) return;
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
    const dy = t.position.y - this.position.y;
    const ok = dy <= MELEE_UP_REACH && dy >= -MELEE_DOWN_REACH;
    _ms.tried++;
    if (ok) _ms.landed++; else _ms.blocked++;
    if (Math.abs(dy) > Math.abs(_ms.maxDy)) _ms.maxDy = +dy.toFixed(2);
    return ok;
  }

  private faceToward(x: number, z: number, dt: number, rate: number): void {
    const want = Math.atan2(x - this.position.x, z - this.position.z);
    let d = want - this.root.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.root.rotation.y += d * Math.min(1, rate * dt);
  }

  private pickWanderGoal(ctx: EnemyCtx): void {
    const a = Math.random() * Math.PI * 2;
    const r = 2 + Math.random() * 6;
    const gx = this.home.x + Math.cos(a) * r;
    const gz = this.home.z + Math.sin(a) * r;
    if (this.species !== 'peckit' && ctx.world.isWater(gx, gz)) {
      this.goal.copy(this.home);
    } else {
      this.goal.set(gx, 0, gz);
    }
  }

  update(dt: number, ctx: EnemyCtx): void {
    if (this.isDead) return;
    this.retarget(ctx);
    this.atkCd -= dt;

    if (this.species === 'gloopling') this.updateGloopling(dt, ctx);
    else if (this.species === 'snortle') this.updateSnortle(dt, ctx);
    else this.updatePeckit(dt, ctx);

    // knockback
    if (this.knock.lengthSq() > 0.001) {
      this.position.x += this.knock.x * dt;
      this.position.z += this.knock.z * dt;
      const d = Math.exp(-6 * dt);
      this.knock.multiplyScalar(d);
    }

    // hit flash
    if (this.flashT > 0) {
      this.flashT -= dt;
      const f = Math.max(0, this.flashT / 0.14) * 0.9;
      for (const m of this.mats) m.emissive.setScalar(f);
    }

    // hp bar
    if (this.hpDirty) {
      this.hpDirty = false;
      this.drawBar();
      this.barSprite.visible = this.hp < this.maxHp;
    }
  }

  /** Move horizontally, refusing to walk into water (ground species). */
  private moveGround(dt: number, dirX: number, dirZ: number, spd: number, ctx: EnemyCtx): void {
    const nx = this.position.x + dirX * spd * dt;
    const nz = this.position.z + dirZ * spd * dt;
    if (ctx.world.isWater(nx, nz)) return;
    this.position.x = nx;
    this.position.z = nz;
  }

  // ------------------------------------------------------------ gloopling
  private updateGloopling(dt: number, ctx: EnemyCtx): void {
    const body = this.parts.body;
    const groundY = ctx.world.getHeight(this.position.x, this.position.z);
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
        _mshit(this.species);
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
    const groundY = ctx.world.getHeight(this.position.x, this.position.z);
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
            _mshit(this.species);
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
        if (ctx.world.isWater(nx, nz)) {
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
            _mshit(this.species);
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
    const groundY = Math.max(ctx.world.getHeight(this.position.x, this.position.z), ctx.world.waterLevel);
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
          _mshit(this.species);
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
    _live.delete(this);
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
