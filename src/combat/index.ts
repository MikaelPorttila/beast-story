import * as THREE from "three";
import {
  ELEMENT_COLORS,
  inRise,
  type CastRequest,
  type Damageable,
  type ElementType,
  type EventBus,
  type FetchJob,
  type ItemDef,
  type SkillDef,
  type World,
} from "../core/types";
import { RARE_DROP_IDS, SHARD_ID, STACKABLE_IDS, itemDef } from "../core/items";
import type { StringKey } from "../i18n";
import { VFX } from "./vfx";
import { DamageNumbers } from "./damage-numbers";
import { elementMultiplier } from "./effectiveness";
import {
  Enemy,
  enemySpecies,
  speciesOf,
  variantForHeight,
  MELEE_UP_REACH,
  MELEE_DOWN_REACH,
  type EnemyCtx,
} from "./enemies";
import { Pickups } from "./pickups";
import { buildArrow } from "./arrow";
import { disposeTameOrbs, tameOrbMesh } from "./tame-orb";
import { Taming, captureChance, refuseThrow, type ThrowRefusal } from "./taming";
import { perf } from "../core/profiler";
import { flags } from "../core/flags";

// _a/_b are for top-level cast helpers, _from/_leaf for leaf helpers, so nesting
// never clobbers a live temp.
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _from = new THREE.Vector3();
const _leaf = new THREE.Vector3();

// Exported: the aim assist must ask the SAME reach question the arc will.
export const SWORD_REACH = 2.2;
/** cos of the arc's HALF-angle. 0.643 is ~50 degrees each side, ~100 total. */
export const SWORD_ARC_COS = 0.643;

// The column an AoE DRAWS and the band it DAMAGES, one number (issue #78).
const AOE_COLUMN_H = 3.6;

const PROJ_SPEED = 16;

/**
 * How high over the straight line a lofted orb passes at mid-flight, world
 * units — see `throwOrb`. 0.7 is most of a terrain cube, which is the size of
 * the tussocks and cube corners the flat throw died on.
 */
const ORB_LOFT_CLEAR = 0.7;
/**
 * Ceiling on the loft, ~27 deg. IT IS A CEILING BECAUSE THE INVERSE LAW RUNS
 * AWAY: at a beast almost underfoot the angle wanted is near vertical, and the
 * orb then sails over a target it had already been going to hit. Measured over
 * 48 bearings at six ranges, an uncapped 39 deg turned 48/48 into 45/48 at 1.5
 * units while buying nothing anywhere else.
 */
const ORB_LOFT_MAX = 0.5;
const PROJ_CAP = 14;
const CRIT_CHANCE = 0.1;
const CRIT_MULT = 1.5;
const CRIT_HEX = 0xffd23f;

const SPAWN_MIN = 8;
const SPAWN_MAX = 14;
const SPAWN_RING_MIN = 25;
const SPAWN_RING_MAX = 60;
const DESPAWN_DIST_SQ = 90 * 90;
const SAFE_ZONE_SQ = 20 * 20;

interface Projectile {
  active: boolean;
  group: THREE.Group;
  shellMat: THREE.MeshBasicMaterial;
  glowMat: THREE.SpriteMaterial;
  light: THREE.PointLight | null;
  vel: THREE.Vector3;
  target: Damageable | null;
  // One pool: everything after firing is the same, only the picture differs.
  bolt: THREE.Object3D[];
  arrow: THREE.Mesh;
  form: ProjForm;
  // PER SLOT, because an `Object3D` is in one place at a time and two orbs of a
  // tier can fly at once; clones share tame-orb.ts's geometry and material.
  orbs: Map<number, THREE.Object3D>;
  orb: THREE.Object3D | null;
  /** Undefined for a PHYSICAL hit — an arrow, like the sword, has no element. */
  element: ElementType | undefined;
  rawBase: number;
  life: number;
  trailT: number;
  hex: number;
  spin: number;
  homing: number;
  // Carried here, not looked up on impact: the item can leave the bag mid-flight
  // and the orb in the air is already paid for.
  orbItem: ItemDef | null;
  orbForce?: boolean;
}

// A state, not a flag: two forms are a boolean, three are not.
type ProjForm = "bolt" | "arrow" | "orb";

export class CombatSystem {
  readonly enemies: Enemy[] = [];

  private vfx: VFX;
  private numbers: DamageNumbers;
  private pickups: Pickups;
  private taming: Taming;
  private shardTotal = 50;
  private time = 0;
  private spawnT = 0;
  private primed = false;
  private targets: Damageable[] = [];
  private lastPlayer: Damageable | null = null;
  private enemyCtx: EnemyCtx;
  private projectiles: Projectile[] = [];
  private projCoreGeo: THREE.BoxGeometry;
  private projShellGeo: THREE.BoxGeometry;

  constructor(
    private scene: THREE.Scene,
    private world: World,
    private bus: EventBus,
  ) {
    this.vfx = new VFX(scene);
    this.numbers = new DamageNumbers(scene);
    this.pickups = new Pickups(scene, this.vfx, (itemId, byBeast) => {
      if (itemDef(itemId).kind === "currency") {
        this.shardTotal += 1;
        this.bus.emit({ type: "shardsChanged", total: this.shardTotal });
      }
      this.bus.emit({ type: "itemPicked", itemId, byBeast });
    });
    this.taming = new Taming(
      scene,
      this.vfx,
      (target, orb, caught) => this.settleBond(target, orb, caught),
      (index, of) => this.bus.emit({ type: "orbWobble", index, of }),
    );
    this.projCoreGeo = new THREE.BoxGeometry(0.15, 0.15, 0.15);
    this.projShellGeo = new THREE.BoxGeometry(0.3, 0.3, 0.3);
    this.enemyCtx = {
      world,
      targets: this.targets,
      vfx: this.vfx,
      time: 0,
      hit: (target, amount, element, fx, fy, fz) =>
        this.onEnemyHit(target, amount, element, fx, fy, fz),
    };
  }

  // Almost everything here is ZONE-LOCAL and goes; the shard total and the pooled
  // GPU resources survive, or the warmed shader programs go with them.
  setWorld(world: World): void {
    this.world = world;
    this.enemyCtx.world = world;
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      this.removeEnemy(i);
    }
    for (const p of this.projectiles) {
      if (!p.active) {
        continue;
      }
      p.active = false;
      p.group.visible = false;
      if (p.light) {
        this.vfx.releaseLight(p.light);
        p.light = null;
      }
    }
    this.pickups.clear();
    this.taming.clear();
    this.targets.length = 0;
    this.lastPlayer = null;
    this.primed = false;
    this.spawnT = 0;
  }

  // `setWorld` covers everything belonging to a PLAY SESSION; the purse is the
  // one number a zone switch carries across and a new game must not.
  reset(): void {
    this.setWorld(this.world);
    this.shardTotal = 50;
    this.bus.emit({ type: "shardsChanged", total: this.shardTotal });
  }

  // The visible purse is `total - spent` across two owners and a save stores the
  // difference, so main.ts zeroes `spent` and hands the balance here (issue
  // #171). The emit is load-bearing: it is how the HUD and the mirror find out.
  setShards(total: number): void {
    if (!Number.isFinite(total)) {
      return;
    }
    this.shardTotal = Math.max(0, Math.floor(total));
    this.bus.emit({ type: "shardsChanged", total: this.shardTotal });
  }

  cast(req: CastRequest): void {
    const skill = req.skill;
    const hex = ELEMENT_COLORS[skill.element];
    switch (skill.targeting) {
      case "projectile":
        this.castProjectile(req, hex);
        break;
      case "beam":
        this.castBeam(req, hex);
        break;
      case "aoe":
        this.castAoe(req, hex);
        break;
      case "melee": {
        _a.set(req.direction.x, 0, req.direction.z);
        if (_a.lengthSq() < 1e-6) {
          _a.set(req.caster.forward.x, 0, req.caster.forward.z);
        }
        if (_a.lengthSq() < 1e-6) {
          _a.set(0, 0, 1);
        }
        _a.normalize();
        this.meleeArc(
          req.origin.x,
          req.origin.y,
          req.origin.z,
          req.caster.position.y,
          _a.x,
          _a.z,
          Math.max(2.4, Math.min(3.4, skill.range)),
          0.42,
          this.skillBase(skill, req.attackStat),
          skill.element,
          hex,
          1.9,
          true,
        );
        break;
      }
      case "self":
      case "support":
        this.castHeal(req, hex);
        break;
    }
  }

  // `footY` is the SOLES and is separate from `origin`, which spawns at chest
  // height: the vertical reach is a feet-to-feet rule.
  meleeStrike(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    attackStat: number,
    footY: number,
  ): void {
    _a.set(direction.x, 0, direction.z);
    if (_a.lengthSq() < 1e-6) {
      return;
    }
    _a.normalize();
    this.meleeArc(
      origin.x,
      origin.y,
      origin.z,
      footY,
      _a.x,
      _a.z,
      SWORD_REACH,
      SWORD_ARC_COS,
      attackStat * 1.2,
      undefined,
      0xdfe9ff,
      1.6,
      false,
    );
  }

  /**
   * The wild enemy nearest the CROSSHAIR that a swing could reach; the aim
   * assist's POLICY stays in main.ts. Reach shares `SWORD_REACH` and the vertical
   * caps with `meleeArc`, because an assist pointing at what the arc refuses is
   * worse than none.
   *
   * Both tests are ANCHORED AT THE HERO. Measuring the bearing at the LENS is a
   * trap: the camera sits ~4 units back, so an enemy at the hero's shoulder reads
   * near-centred and the assist would spin the swing backwards.
   */
  bestMeleeTarget(
    from: THREE.Vector3,
    aim: THREE.Vector3,
    reach: number,
    coneCos: number,
    footY: number,
  ): Damageable | null {
    const al = Math.hypot(aim.x, aim.z);
    if (al < 1e-6) {
      return null;
    }
    const ux = aim.x / al;
    const uz = aim.z / al;

    let best: Enemy | null = null;
    // Seeded with the cone, so "outside it" and "nothing there" are one branch.
    let bestDot = coneCos;
    for (const e of this.enemies) {
      if (!e.targetable) {
        continue;
      }
      if (!inRise(footY, e.position.y, MELEE_UP_REACH, MELEE_DOWN_REACH)) {
        continue;
      }
      const rx = e.position.x - from.x;
      const rz = e.position.z - from.z;
      const rd = Math.sqrt(rx * rx + rz * rz);
      if (rd > reach + e.radius) {
        continue;
      }
      if (rd < 1e-4) {
        continue;
      }
      const dot = (rx / rd) * ux + (rz / rd) * uz;
      if (dot > bestDot) {
        bestDot = dot;
        best = e;
      }
    }
    return best;
  }

  findNearestEnemy(pos: THREE.Vector3, range: number): Damageable | null {
    let best: Damageable | null = null;
    let bd = range * range;
    for (const e of this.enemies) {
      if (!e.targetable) {
        continue;
      }
      const dx = e.position.x - pos.x;
      const dy = e.position.y - pos.y;
      const dz = e.position.z - pos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bd) {
        bd = d2;
        best = e;
      }
    }
    return best;
  }

  spawnDrop(itemId: string, x: number, y: number, z: number, armed = true): void {
    this.pickups.spawn(x, y, z, itemId, armed);
  }

  // For `__dbgShots`; allocates. `arrow` is kept beside `form` because existing
  // probes read it — `form` is what a new reader uses.
  projectileSnapshot(): {
    arrow: boolean;
    form: ProjForm;
    orb: string | null;
    x: number;
    y: number;
    z: number;
    speed: number;
  }[] {
    const out = [];
    for (const p of this.projectiles) {
      if (!p.active) {
        continue;
      }
      const q = p.group.position;
      out.push({
        arrow: p.form === "arrow",
        form: p.form,
        orb: p.orbItem?.id ?? null,
        x: +q.x.toFixed(2),
        y: +q.y.toFixed(2),
        z: +q.z.toFixed(2),
        speed: +p.vel.length().toFixed(2),
      });
    }
    return out;
  }

  findFetchJob(
    from: THREE.Vector3,
    maxDist: number,
    want: (itemId: string) => boolean,
  ): FetchJob | null {
    return this.pickups.findJob(from, maxDist, want);
  }

  dropSnapshot(): { itemId: string; x: number; z: number; claimed: boolean; age: number }[] {
    return this.pickups.snapshot();
  }

  update(dt: number, player: Damageable, friendlies: Damageable[]): void {
    this.time += dt;
    this.enemyCtx.time = this.time;
    this.lastPlayer = player;

    this.targets.length = 0;
    if (!player.isDead) {
      this.targets.push(player);
    }
    for (const f of friendlies) {
      if (!f.isDead) {
        this.targets.push(f);
      }
    }

    // `enemies=0` suppresses the whole population, priming included.
    if (flags.enemies) {
      if (!this.primed) {
        this.primed = true;
        for (let i = 0; i < 30 && this.enemies.length < 11; i++) {
          this.trySpawn(player.position, true);
        }
      }
      this.spawnT -= dt;
      if (this.spawnT <= 0) {
        this.spawnT = this.enemies.length < SPAWN_MIN ? 0.35 : 2.4;
        if (this.enemies.length < SPAWN_MAX) {
          this.trySpawn(player.position, false);
        }
      }
    }

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      e.update(dt, this.enemyCtx);
      if (e.isDead) {
        this.killEnemy(e, i);
        continue;
      }
      const dx = e.position.x - player.position.x;
      const dz = e.position.z - player.position.z;
      if (dx * dx + dz * dz > DESPAWN_DIST_SQ) {
        this.removeEnemy(i);
      }
    }

    this.updateProjectiles(dt);
    // After the projectiles, so an orb landing THIS slice starts its ceremony
    // now rather than a frame late.
    this.taming.update(dt);
    this.pickups.update(dt, player.position, this.world);
    this.vfx.update(dt);
    this.numbers.update(dt);
  }

  private skillBase(skill: SkillDef, attackStat: number): number {
    return skill.power * (attackStat / 10);
  }

  private dealSkillDamage(
    enemy: Enemy,
    rawBase: number,
    element: ElementType | undefined,
    fromX: number,
    fromY: number,
    fromZ: number,
    bySkill: boolean,
  ): void {
    const mult = elementMultiplier(element, enemy.element);
    const crit = Math.random() < CRIT_CHANCE;
    const dmg = Math.max(1, Math.round(rawBase * mult * (crit ? CRIT_MULT : 1)));
    _from.set(fromX, fromY, fromZ);
    if (!enemy.takeDamage(dmg, _from, element)) {
      return;
    }
    const hex = crit ? CRIT_HEX : element ? ELEMENT_COLORS[element] : 0xf2f6ff;
    const px = enemy.position.x,
      py = enemy.position.y,
      pz = enemy.position.z;
    this.numbers.spawn(px, py + enemy.height + 0.35, pz, String(dmg), hex, crit);
    this.vfx.burst(px, py + enemy.height * 0.5, pz, hex, crit ? 14 : 8, 3.6, 0.32, 0.22, -2, 0.4);
    if (mult > 1) {
      this.vfx.glowPulse(px, py + enemy.height * 0.5, pz, hex, 1.6, 0.22);
    }
    this.bus.emit({
      type: "hitDealt",
      amount: dmg,
      crit,
      superEffective: mult > 1,
      element,
      bySkill,
      x: px,
      y: py + enemy.height * 0.5,
      z: pz,
    });
  }

  // Everything below the gate is CONDITIONAL on the hit landing: `takeDamage`
  // refuses hits inside its invulnerability window, and an absorbed hit must not
  // flash, pop or rumble.
  private onEnemyHit(
    target: Damageable,
    amount: number,
    element: ElementType,
    fromX: number,
    fromY: number,
    fromZ: number,
  ): void {
    const dmg = Math.max(1, Math.round(amount));
    _from.set(fromX, fromY, fromZ);
    if (!target.takeDamage(dmg, _from, element)) {
      return;
    }
    const px = target.position.x,
      py = target.position.y,
      pz = target.position.z;
    this.numbers.spawn(px, py + 1.5, pz, String(dmg), 0xff6b57, false);
    this.vfx.burst(px, py + 0.9, pz, ELEMENT_COLORS[element], 9, 3.2, 0.32, 0.2, -2, 0.4);
    if (target === this.lastPlayer) {
      this.vfx.screenFlash(0xff3822, 0.14);
    }
  }

  private meleeArc(
    ox: number,
    oy: number,
    oz: number,
    footY: number,
    dx: number,
    dz: number,
    reach: number,
    arcCos: number,
    rawBase: number,
    element: ElementType | undefined,
    hex: number,
    slashScale: number,
    bySkill: boolean,
  ): void {
    this.vfx.slash(ox + dx * 1.05, oy + 0.15, oz + dz * 1.05, dx, dz, hex, slashScale);
    this.vfx.flashLight(ox + dx * 1.1, oy + 0.5, oz + dz * 1.1, hex, 2.4, 5, 0.14);
    for (const e of this.enemies) {
      if (!e.targetable) {
        continue;
      }
      // An arc is a WEDGE, and a wedge with no ceiling is a column (issue #78).
      // Same pair of numbers as the bite that comes back.
      if (!inRise(footY, e.position.y, MELEE_UP_REACH, MELEE_DOWN_REACH)) {
        continue;
      }
      const ex = e.position.x - ox;
      const ez = e.position.z - oz;
      const d = Math.sqrt(ex * ex + ez * ez);
      if (d > reach + e.radius) {
        continue;
      }
      if (d > 0.2 && (ex / d) * dx + (ez / d) * dz < arcCos) {
        continue;
      }
      this.dealSkillDamage(e, rawBase, element, ox, oy, oz, bySkill);
    }
  }

  private projSlot(): Projectile | null {
    for (const p of this.projectiles) {
      if (!p.active) {
        return p;
      }
    }
    if (this.projectiles.length >= PROJ_CAP) {
      return null;
    }
    const shellMat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const glowMat = new THREE.SpriteMaterial({
      map: this.vfx.glowTexture,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const group = new THREE.Group();
    const glow = new THREE.Sprite(glowMat);
    glow.scale.setScalar(1.45);
    const shell = new THREE.Mesh(this.projShellGeo, shellMat);
    const core = new THREE.Mesh(this.projCoreGeo, coreMat);
    glow.renderOrder = 21;
    shell.renderOrder = 22;
    core.renderOrder = 23;
    group.add(glow);
    group.add(shell);
    group.add(core);
    group.visible = false;
    this.scene.add(group);
    const arrow = buildArrow();
    arrow.visible = false;
    group.add(arrow);
    const p: Projectile = {
      active: false,
      group,
      shellMat,
      glowMat,
      light: null,
      bolt: [glow, shell, core],
      arrow,
      form: "bolt",
      // Filled by `orbFor` on the first throw of a tier through this slot.
      orbs: new Map(),
      orb: null,
      orbItem: null,
      vel: new THREE.Vector3(),
      target: null,
      element: "fire",
      rawBase: 0,
      life: 0,
      trailT: 0,
      hex: 0xffffff,
      spin: 0,
      homing: 1,
    };
    this.projectiles.push(p);
    return p;
  }

  private castProjectile(req: CastRequest, hex: number): void {
    const p = this.projSlot();
    if (!p) {
      return;
    }
    const skill = req.skill;
    p.active = true;
    p.element = skill.element;
    p.hex = hex;
    p.rawBase = this.skillBase(skill, req.attackStat);
    p.target = req.target && !req.target.isDead ? req.target : null;
    p.life = Math.max(0.8, (Math.max(8, skill.range) + 4) / PROJ_SPEED);
    p.trailT = 0;
    p.spin = Math.random() * Math.PI;
    p.homing = req.homingScale ?? 1;
    this.setProjectileForm(p, "bolt");
    p.vel.copy(req.direction).normalize().multiplyScalar(PROJ_SPEED);
    p.group.position.copy(req.origin).addScaledVector(req.direction, 0.45);
    p.shellMat.color.setHex(hex);
    p.glowMat.color.setHex(hex);
    p.group.visible = true;
    p.light = this.vfx.acquireLight(hex, 3.2, 7);
    if (p.light) {
      p.light.position.copy(p.group.position);
    }
    this.vfx.glowPulse(req.origin.x, req.origin.y, req.origin.z, hex, 1.1, 0.2);
    this.vfx.burst(req.origin.x, req.origin.y, req.origin.z, hex, 7, 2.2, 0.28, 0.18, 0, 0.3);
  }

  warmUpLight(at: THREE.Vector3): void {
    this.vfx.warmUpLights(at.x, at.y, at.z, 1);
  }

  // A drop's three materials are drawn nowhere else, so an unwarmed zone links
  // them the first time something dies in it.
  warmUpDrop(at: THREE.Vector3): void {
    this.pickups.warmUpDrop(at.x, at.y + 0.4, at.z);
  }

  endWarmUpDrop(): void {
    this.pickups.retireWarmUpDrop();
  }

  // Staged UNDER the floor: a program links when its material is bound for a
  // draw, not when its fragments pass depth, so this leaves no scorch on the pad.
  warmUpEffects(at: THREE.Vector3): void {
    this.vfx.warmUp(at.x, at.y - 0.8, at.z);
  }

  warmUp(at: THREE.Vector3, lights: number): void {
    const p = this.projSlot();
    if (p) {
      p.active = true;
      p.element = "fire";
      p.hex = 0xffffff;
      p.rawBase = 0;
      p.target = null;
      p.life = 0.05;
      p.trailT = 0;
      p.spin = 0;
      this.setProjectileForm(p, "bolt");
      p.vel.set(0, 0, 0);
      p.group.position.copy(at);
      p.group.visible = true;
      p.light = this.vfx.acquireLight(0xffffff, 0.001, 4);
      if (p.light) {
        p.light.position.copy(at);
      }
    }
    this.numbers.spawn(at.x, at.y + 1, at.z, "1", 0xffffff, true);
    this.pickups.spawn(at.x, at.y, at.z);
    this.vfx.warmUp(at.x, at.y, at.z);
    this.vfx.warmUpLights(at.x, at.y, at.z, lights);
  }

  // Cloned per SLOT: the cached mesh cannot hang off two live projectiles.
  private orbFor(p: Projectile, color: number): THREE.Object3D {
    let m = p.orbs.get(color);
    if (!m) {
      m = tameOrbMesh(color).clone();
      m.visible = false;
      p.group.add(m);
      p.orbs.set(color, m);
    }
    return m;
  }

  // ONE PLACE, so a recycled slot never shows half of two forms. No early-out on
  // `form`: two orb tiers share a form and not a mesh.
  private setProjectileForm(
    p: Projectile,
    form: ProjForm,
    orb: THREE.Object3D | null = null,
  ): void {
    p.form = form;
    for (const part of p.bolt) {
      part.visible = form === "bolt";
    }
    p.arrow.visible = form === "arrow";
    // Every orb this slot ever built, so the swap is total, never a diff.
    for (const m of p.orbs.values()) {
      m.visible = m === orb;
    }
    p.orb = form === "orb" ? orb : null;
  }

  // NO HOMING and NO TARGET, unlike everything else the pool fires: a bow shot
  // goes where the crosshair points, and curving it takes the aim away from the
  // player who just aimed.
  arrowStrike(origin: THREE.Vector3, direction: THREE.Vector3, attackStat: number): void {
    _a.set(direction.x, direction.y, direction.z);
    if (_a.lengthSq() < 1e-6) {
      return;
    }
    _a.normalize();
    const p = this.projSlot();
    if (!p) {
      return;
    }
    p.active = true;
    p.element = undefined;
    p.hex = 0xf2f6ff;
    p.rawBase = attackStat * 1.2;
    p.target = null;
    p.homing = 0;
    p.life = 1.6; // ~26 units of flight at PROJ_SPEED
    p.trailT = 0;
    p.spin = 0;
    this.setProjectileForm(p, "arrow");
    p.vel.copy(_a).multiplyScalar(PROJ_SPEED);
    p.group.position.copy(origin).addScaledVector(_a, 0.5);
    p.group.visible = true;
    // No light, no muzzle pop: an arrow is not on fire. A dust puff instead.
    p.light = null;
    this.vfx.dust(origin.x, origin.y, origin.z, 3, 0xd8d2c4);
  }

  // `rawBase` stays 0: an orb that chipped a beast would weaken the thing whose
  // weakness it measures. IT HOMES where an arrow does not — a throw spends a
  // consumable at a target the game highlighted, so a side-step is an orb gone.
  throwOrb(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    def: ItemDef,
    target: Damageable | null,
    force?: boolean,
  ): void {
    _a.set(direction.x, direction.y, direction.z);
    if (_a.lengthSq() < 1e-6) {
      return;
    }
    _a.normalize();
    // LOFTED, because the flat throw was a bug at every range. The line from the
    // hand (ORB_THROW_RISE, 1.1) down to a beast's chest (+0.55) DESCENDS, so it
    // runs a hand's breadth over the ground for its whole length and dies on the
    // first tussock between the two — measured over 32 bearings, 2 clipped at
    // 1.5 units and 4 at 9, worst clearance -0.79.
    //
    // THE ANGLE IS INVERSE IN DISTANCE, which is the opposite of the instinct.
    // Mid-flight height over the straight line is tan(angle) * d / 2, so buying
    // the same clearance over a SHORT throw takes a steeper one: about 34 deg at
    // 1.5 units against 4 at 14. That is also what the throw should look like —
    // an orb tossed at something underfoot arcs, and one lobbed across a clearing
    // barely lifts.
    //
    // It costs the shot nothing because the orb HOMES (see updateProjectiles):
    // the lift is spent clearing the ground and the homing spends the rest of the
    // flight taking the orb back down onto the target. Replaying this integrator
    // over real terrain, 48 bearings a range: 4 units 46/48 -> 48/48, 6 44 -> 48,
    // 9 42 -> 48, 14 33 -> 37, and nothing lost at 1.5 or 2.5. A throw across a
    // HILL is a different miss and still misses — this is about the ground under
    // a throw, not the ridge in the middle of one.
    if (target) {
      const dx = target.position.x - origin.x;
      const dz = target.position.z - origin.z;
      const flat = Math.hypot(dx, dz);
      if (flat > 1e-3) {
        _a.y += Math.min(ORB_LOFT_MAX, (2 * ORB_LOFT_CLEAR) / flat);
        _a.normalize();
      }
    }
    const p = this.projSlot();
    if (!p) {
      return;
    }
    p.active = true;
    p.element = undefined;
    p.hex = def.color;
    p.rawBase = 0;
    p.target = target && !target.isDead ? target : null;
    p.homing = 1;
    // Long enough never to expire before arriving (issue #110): the life is only
    // the guarantee a slot comes back. The ground still ends a throw early.
    p.life = 10;
    p.trailT = 0;
    p.spin = 0;
    p.orbItem = def;
    p.orbForce = force;
    this.setProjectileForm(p, "orb", this.orbFor(p, def.color));
    p.vel.copy(_a).multiplyScalar(PROJ_SPEED);
    p.group.position.copy(origin).addScaledVector(_a, 0.5);
    p.group.visible = true;
    // A light, unlike the arrow — an orb's core is lit. Dimmer than a bolt's:
    // it is a lamp, not an explosion.
    p.light = this.vfx.acquireLight(def.color, 1.6, 5);
    if (p.light) {
      p.light.position.copy(p.group.position);
    }
    this.vfx.glowPulse(origin.x, origin.y, origin.z, def.color, 0.7, 0.16);
  }

  private updateProjectiles(dt: number): void {
    for (const p of this.projectiles) {
      if (!p.active) {
        continue;
      }
      p.life -= dt;
      const pos = p.group.position;
      if (p.life <= 0) {
        this.explodeProjectile(p, pos.x, pos.y, pos.z, null);
        continue;
      }
      const t = p.target;
      if (t && !t.isDead) {
        _leaf.set(t.position.x - pos.x, t.position.y + 0.55 - pos.y, t.position.z - pos.z);
        if (_leaf.lengthSq() > 1e-4) {
          _leaf.normalize().multiplyScalar(PROJ_SPEED);
          // 3.4 is full lock-on; scaled down, the shot merely leans.
          p.vel.lerp(_leaf, Math.min(1, 3.4 * p.homing * dt)).setLength(PROJ_SPEED);
        }
      }
      pos.addScaledVector(p.vel, dt);
      if (p.form === "arrow") {
        // Points where it is going — what the +Z build direction is for.
        _leaf.copy(pos).add(p.vel);
        p.group.lookAt(_leaf);
      } else if (p.form === "orb") {
        // Rolling about local z AFTER the lookAt is the only order that keeps
        // both the aim and the spin; writing `rotation` throws the aim away.
        _leaf.copy(pos).add(p.vel);
        p.group.lookAt(_leaf);
        p.spin += dt * 7;
        p.group.rotateZ(p.spin);
      } else {
        p.spin += dt * 9;
        p.group.rotation.set(p.spin * 0.7, p.spin, p.spin * 0.45);
      }
      if (p.light) {
        p.light.position.copy(pos);
      }
      p.trailT -= dt;
      while (p.trailT <= 0) {
        p.trailT += 0.022;
        // Only the BOLT sparkles: on wood or glass a trail reads as burning.
        if (p.form === "bolt") {
          this.vfx.trail(pos.x, pos.y, pos.z, p.hex, 0.3);
        }
      }
      let hit: Enemy | null = null;
      for (const e of this.enemies) {
        if (!e.targetable) {
          continue;
        }
        const dx = e.position.x - pos.x;
        const dy = e.position.y + e.height * 0.5 - pos.y;
        const dz = e.position.z - pos.z;
        const rr = e.radius + 0.5;
        if (dx * dx + dy * dy + dz * dz < rr * rr) {
          hit = e;
          break;
        }
      }
      if (hit) {
        this.explodeProjectile(p, pos.x, pos.y, pos.z, hit);
        continue;
      }
      const gy = this.world.getHeight(pos.x, pos.z);
      if (pos.y <= gy + 0.1) {
        pos.y = gy + 0.1;
        this.explodeProjectile(p, pos.x, pos.y, pos.z, null);
      }
    }
  }

  private explodeProjectile(
    p: Projectile,
    x: number,
    y: number,
    z: number,
    direct: Enemy | null,
  ): void {
    p.active = false;
    p.group.visible = false;
    if (p.light) {
      this.vfx.releaseLight(p.light);
      p.light = null;
    }
    // AN ORB DOES NOT EXPLODE, and this is the one place a life ends.
    if (p.orbItem) {
      this.landOrb(p, x, y, z, direct);
      return;
    }
    this.vfx.burst(x, y, z, p.hex, 26, 6.5, 0.5, 0.32, -4, 0.5);
    this.vfx.glowPulse(x, y, z, p.hex, 2.4, 0.28);
    this.vfx.flashLight(x, y, z, p.hex, 6, 9, 0.26);
    const gy = this.world.getHeight(x, z);
    this.vfx.ring(x, gy, z, p.hex, 1.9, 0.45);
    if (y - gy < 1.2) {
      this.vfx.scorch(x, gy, z, p.hex, 1.1);
    }
    if (direct) {
      this.dealSkillDamage(direct, p.rawBase, p.element, x, y, z, true);
    }
    // Splash. A BALL of fire, so the vertical band is the radius itself and is
    // symmetric — as a column it singed flyers thirty units up (issue #78).
    for (const e of this.enemies) {
      if (!e.targetable || e === direct) {
        continue;
      }
      const dx = e.position.x - x;
      const dz = e.position.z - z;
      const rr = 1.9 + e.radius;
      if (!inRise(y, e.position.y, rr)) {
        continue;
      }
      if (dx * dx + dz * dz < rr * rr) {
        this.dealSkillDamage(e, p.rawBase * 0.55, p.element, x, y, z, true);
      }
    }
  }

  // THE ORB IS SPENT EITHER WAY, decided in main.ts at the throw: refunding a
  // miss would make throwing at nothing free.
  private landOrb(p: Projectile, x: number, y: number, z: number, direct: Enemy | null): void {
    const orb = p.orbItem!;
    const force = p.orbForce;
    p.orbItem = null;
    p.orbForce = undefined;
    const gy = this.world.getHeight(x, z);
    if (direct && refuseThrow(orb, direct) === "ok") {
      this.taming.begin(orb, direct, force);
      return;
    }
    this.vfx.debrisBurst(x, y, z, [orb.color, 0xf4f7fb], 9, 3.8, 0.09, gy);
    this.vfx.burst(x, y, z, orb.color, 12, 3.4, 0.36, 0.18, -7, 0.3);
    this.vfx.glowPulse(x, y, z, orb.color, 1.1, 0.2);
  }

  // A SECOND REMOVAL PATH beside `killEnemy`: that one pays shards, rolls the
  // drop table and grants xp, and a bond is none of those.
  private settleBond(target: Enemy, orb: ItemDef, caught: boolean): void {
    const beastId = target.beastSpecies?.id ?? target.species;
    if (!caught) {
      this.bus.emit({ type: "bondFailed", beastId, nameKey: target.nameKey, orbId: orb.id });
      return;
    }
    const i = this.enemies.indexOf(target);
    if (i >= 0) {
      this.removeEnemy(i);
    }
    this.bus.emit({ type: "beastTamed", beastId, nameKey: target.nameKey, orbId: orb.id });
  }

  // Forwarded, because main.ts holds an `Enemy` only as a `Damageable` and
  // handing the UI the concrete class is reaching across.
  bondChance(orb: ItemDef, target: Damageable | null): number {
    const e = target as Enemy | null;
    if (!e || !(e instanceof Enemy)) {
      return 0;
    }
    return captureChance(orb, e);
  }

  bondRefusal(orb: ItemDef, target: Damageable | null): ThrowRefusal {
    const e = target as Enemy | null;
    return refuseThrow(orb, e instanceof Enemy ? e : null);
  }

  bondSpeciesOf(target: Damageable | null): string | null {
    const e = target as Enemy | null;
    return e instanceof Enemy ? (e.beastSpecies?.id ?? null) : null;
  }

  bondNameKeyOf(target: Damageable | null): StringKey | null {
    const e = target as Enemy | null;
    return e instanceof Enemy ? e.nameKey : null;
  }

  /** True while any orb is wobbling. `__dbgTaming` and the probe read it. */
  get bonding(): boolean {
    return this.taming.busy;
  }

  private castBeam(req: CastRequest, hex: number): void {
    const range = Math.max(6, req.skill.range);
    _a.copy(req.direction).normalize();
    let best: Enemy | null = null;
    let bestT = range;
    for (const e of this.enemies) {
      if (!e.targetable) {
        continue;
      }
      _b.set(
        e.position.x - req.origin.x,
        e.position.y + e.height * 0.5 - req.origin.y,
        e.position.z - req.origin.z,
      );
      const t = _b.dot(_a);
      if (t < 0.5 || t > bestT) {
        continue;
      }
      const perp2 = _b.lengthSq() - t * t;
      const rr = e.radius + 0.55;
      if (perp2 < rr * rr) {
        bestT = t;
        best = e;
      }
    }
    _b.copy(req.origin).addScaledVector(_a, bestT);
    this.vfx.beam(req.origin, _b, hex);
    this.vfx.glowPulse(
      req.origin.x + _a.x * 0.5,
      req.origin.y + _a.y * 0.5,
      req.origin.z + _a.z * 0.5,
      hex,
      1.0,
      0.18,
    );
    this.vfx.burst(_b.x, _b.y, _b.z, hex, best ? 20 : 10, 5, 0.4, 0.28, -2, 0.5);
    this.vfx.flashLight(_b.x, _b.y, _b.z, hex, 5, 8, 0.22);
    const steps = Math.min(14, Math.floor(bestT / 0.9));
    for (let i = 1; i <= steps; i++) {
      const d = (bestT * i) / (steps + 1);
      this.vfx.trail(
        req.origin.x + _a.x * d,
        req.origin.y + _a.y * d,
        req.origin.z + _a.z * d,
        hex,
        0.28,
      );
    }
    if (best) {
      this.dealSkillDamage(
        best,
        this.skillBase(req.skill, req.attackStat),
        req.skill.element,
        req.origin.x,
        req.origin.y,
        req.origin.z,
        true,
      );
    }
  }

  private castAoe(req: CastRequest, hex: number): void {
    const skill = req.skill;
    const t = req.target;
    if (t && !t.isDead) {
      _a.copy(t.position);
    } else {
      _a.copy(req.origin).addScaledVector(req.direction, Math.max(3, skill.range * 0.6));
    }
    const gy = this.world.getHeight(_a.x, _a.z);
    const cx = _a.x,
      cz = _a.z;
    const radius = 3.1;
    this.vfx.ring(cx, gy, cz, hex, radius + 0.7, 0.55);
    this.vfx.ring(cx, gy, cz, hex, radius * 0.55, 0.38);
    this.vfx.rise(cx, gy, cz, hex, 30, radius * 0.75, AOE_COLUMN_H, 0.85, 0.42, 2.6);
    this.vfx.burst(cx, gy + 0.5, cz, hex, 22, 5.5, 0.5, 0.3, -3, 0.8);
    this.vfx.scorch(cx, gy, cz, hex, radius * 0.8);
    this.vfx.flashLight(cx, gy + 1.2, cz, hex, 6.5, 11, 0.32);
    this.vfx.screenFlash(hex, 0.06);
    const base = this.skillBase(skill, req.attackStat);
    for (const e of this.enemies) {
      if (!e.targetable) {
        continue;
      }
      // Reaches as high as it is DRAWN reaching, symmetric (issue #78).
      if (!inRise(gy, e.position.y, AOE_COLUMN_H)) {
        continue;
      }
      const dx = e.position.x - cx;
      const dz = e.position.z - cz;
      const rr = radius + e.radius;
      if (dx * dx + dz * dz < rr * rr) {
        this.dealSkillDamage(e, base, skill.element, cx, gy + 0.4, cz, true);
      }
    }
  }

  private castHeal(req: CastRequest, hex: number): void {
    const skill = req.skill;
    this.vfx.rise(
      req.origin.x,
      req.origin.y - 0.6,
      req.origin.z,
      hex,
      14,
      0.65,
      2.0,
      0.8,
      0.4,
      3.2,
    );
    let best: Damageable | null = null;
    let bestRatio = 0.999;
    for (const f of this.targets) {
      const r = f.hp / Math.max(1, f.maxHp);
      if (r < bestRatio) {
        bestRatio = r;
        best = f;
      }
    }
    if (!best) {
      return;
    }
    const heal = Math.max(1, Math.round(skill.power));
    best.hp = Math.min(best.maxHp, best.hp + heal);
    const px = best.position.x,
      py = best.position.y,
      pz = best.position.z;
    const gy = this.world.getHeight(px, pz);
    this.vfx.rise(px, gy, pz, hex, 26, 0.9, 2.6, 0.95, 0.5, 3.6);
    this.vfx.ring(px, gy, pz, hex, 1.7, 0.5);
    this.vfx.glowPulse(px, py + 1.0, pz, hex, 1.8, 0.35);
    this.vfx.flashLight(px, py + 1.2, pz, hex, 3, 7, 0.4);
    this.numbers.spawn(px, py + 1.8, pz, `+${heal}`, 0x8cf59a, false);
  }

  private trySpawn(center: THREE.Vector3, silent: boolean): void {
    // Uniform over whatever content loaded. `enemySpecies()` is a cached frozen
    // view, so this is a read: a spawn path may not allocate a table.
    const defs = enemySpecies();
    if (defs.length === 0) {
      return;
    }
    const def = defs[(Math.random() * defs.length) | 0];
    const a = Math.random() * Math.PI * 2;
    const r = SPAWN_RING_MIN + Math.random() * (SPAWN_RING_MAX - SPAWN_RING_MIN);
    const x = center.x + Math.cos(a) * r;
    const z = center.z + Math.sin(a) * r;
    const sp = this.world.spawnPoint;
    const sx = x - sp.x,
      sz = z - sp.z;
    if (sx * sx + sz * sz < SAFE_ZONE_SQ) {
      return;
    }
    // A refusal, not a re-roll: a keep-out must THIN the population near a
    // settlement, not queue it along the boundary as a visible wall.
    if (this.world.safeZones.blocksSpawn(x, z)) {
      return;
    }
    if (!def.flying && this.world.isWater(x, z)) {
      return;
    }
    const gy = this.world.getHeight(x, z);
    const variant = variantForHeight(gy - this.world.waterLevel);
    const e = new Enemy(def.id, variant, x, z, this.world);
    this.scene.add(e.root);
    this.enemies.push(e);
    perf.count("enemies");
    if (!silent) {
      const hex = ELEMENT_COLORS[e.element];
      this.vfx.dust(x, gy + 0.06, z, 12);
      this.vfx.ring(x, gy, z, hex, 1.5, 0.5);
      this.vfx.glowPulse(x, gy + 0.6, z, hex, 1.6, 0.3);
    }
  }

  // F3 Debug panel only. Obeys none of `trySpawn`'s rules, which shape a
  // population that appears on its own where this is a person pointing at a
  // spot. Null for an unknown id, because a panel row is user input.
  spawnOne(id: string, x: number, z: number): Enemy | null {
    if (!speciesOf(id)) {
      return null;
    }
    const e = new Enemy(
      id,
      variantForHeight(this.world.getHeight(x, z) - this.world.waterLevel),
      x,
      z,
      this.world,
    );
    this.scene.add(e.root);
    this.enemies.push(e);
    perf.count("enemies");
    return e;
  }

  private killEnemy(e: Enemy, i: number): void {
    const px = e.position.x,
      py = e.position.y,
      pz = e.position.z;
    const gy = this.world.getHeight(px, pz);
    const hex = ELEMENT_COLORS[e.element];
    this.vfx.debrisBurst(px, py + e.height * 0.5, pz, e.palette, 14, 5.5, 0.14, gy);
    this.vfx.burst(px, py + e.height * 0.5, pz, hex, 26, 6.5, 0.55, 0.32, -4, 0.6);
    this.vfx.ring(px, gy, pz, hex, 2.2, 0.5);
    this.vfx.glowPulse(px, py + e.height * 0.5, pz, hex, 2.4, 0.32);
    this.vfx.flashLight(px, py + 0.8, pz, hex, 5, 9, 0.3);
    const xp = e.xp + ((Math.random() * 5) | 0);
    this.bus.emit({ type: "enemyKilled", nameKey: e.nameKey, xp });
    const drops = 1 + ((Math.random() * 3) | 0);
    for (let k = 0; k < drops; k++) {
      this.pickups.spawn(px, py + 0.6, pz, SHARD_ID);
    }
    // Frequent enough to turn up in play, rare enough not to litter. First pass.
    if (Math.random() < 0.25) {
      const id = STACKABLE_IDS[(Math.random() * STACKABLE_IDS.length) | 0];
      this.pickups.spawn(px, py + 0.6, pz, id);
    }
    // The RARE half, never fetched by a beast, so each one is something the
    // player walked over and noticed. Never a weapon: those are forged or given.
    if (Math.random() < 0.04) {
      const id = RARE_DROP_IDS[(Math.random() * RARE_DROP_IDS.length) | 0];
      this.pickups.spawn(px, py + 0.6, pz, id);
    }
    this.removeEnemy(i);
  }

  private removeEnemy(i: number): void {
    const e = this.enemies[i];
    this.scene.remove(e.root);
    e.dispose();
    const last = this.enemies.length - 1;
    this.enemies[i] = this.enemies[last];
    this.enemies.pop();
  }

  // NARROW ON PURPOSE: nothing tears a `CombatSystem` down, so this covers only
  // the taming meshes and the orb geometry. The clones leave before it is freed.
  dispose(): void {
    this.taming.dispose();
    // The pool's clones share these buffers, so they are dropped, not disposed.
    for (const p of this.projectiles) {
      for (const m of p.orbs.values()) {
        p.group.remove(m);
      }
      p.orbs.clear();
      p.orb = null;
    }
    disposeTameOrbs();
  }
}
