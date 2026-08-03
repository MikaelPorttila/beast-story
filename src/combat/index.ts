import * as THREE from 'three';
import {
  ELEMENT_COLORS,
  type CastRequest,
  type Damageable,
  type ElementType,
  type EventBus,
  type FetchJob,
  type SkillDef,
  type World,
} from '../core/types';
import { SHARD_ID, STACKABLE_IDS, itemDef } from '../core/items';
import { VFX } from './vfx';
import { DamageNumbers } from './damage-numbers';
import { elementMultiplier } from './effectiveness';
import { Enemy, enemySpecies, variantForHeight, type EnemyCtx } from './enemies';
import { Pickups } from './pickups';
import { perf } from '../core/profiler';
import { flags } from '../core/flags';

/**
 * CombatSystem: the orchestrator. Owns VFX, damage numbers, shard pickups and
 * the wild-enemy population; executes skill casts and the player's sword.
 */

// Module-level temps — no per-frame allocations in hot loops.
// _a/_b are for top-level cast helpers; _from/_leaf are for leaf helpers so
// nesting never clobbers a live temp.
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _from = new THREE.Vector3();
const _leaf = new THREE.Vector3();

/**
 * The player's sword, as two numbers rather than two literals inside one call.
 *
 * Exported because the melee aim assist has to ask the SAME reach question the
 * arc will ask — see `bestMeleeTarget`. A second copy of `2.2` living in main.ts
 * would be a copy that can drift, and the failure it drifts into is silent: an
 * assist aiming at something out of range simply makes the swing miss.
 */
export const SWORD_REACH = 2.2;
/** cos of the arc's HALF-angle. 0.643 is ~50 degrees each side, ~100 total. */
export const SWORD_ARC_COS = 0.643;

const PROJ_SPEED = 16;
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
  element: ElementType;
  rawBase: number;
  life: number;
  trailT: number;
  hex: number;
  spin: number;
  /** 0..1 steer strength toward `target`; see CastRequest.homingScale. */
  homing: number;
}

export class CombatSystem {
  /** Live wild enemies (satisfies ReadonlyArray<Damageable>). */
  readonly enemies: Enemy[] = [];

  private vfx: VFX;
  private numbers: DamageNumbers;
  private pickups: Pickups;
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
      // Currency is a running total owned here; everything else is just
      // reported and the bag in main.ts decides what to do with it.
      if (itemDef(itemId).kind === 'currency') {
        this.shardTotal += 1;
        this.bus.emit({ type: 'shardsChanged', total: this.shardTotal });
      }
      this.bus.emit({ type: 'itemPicked', itemId, byBeast });
    });
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

  /**
   * Rebind to another zone's World (see world/zones.ts).
   *
   * Unlike the hero and the beasts, most of what combat holds is ZONE-LOCAL and
   * has to go: wild enemies were spawned on the old ground and each captured
   * that world themselves, projectiles are in flight over it, and drops are
   * lying on it. What survives is the running shard total — the one piece of
   * player state this system owns — and the pooled geometry, materials and
   * lights, which is the reason to rebind rather than rebuild: reconstructing
   * CombatSystem would throw away every warmed shader program with it.
   *
   * `primed` is cleared so the new zone gets its own starting population
   * instead of inheriting an empty one.
   */
  setWorld(world: World): void {
    this.world = world;
    this.enemyCtx.world = world;
    for (let i = this.enemies.length - 1; i >= 0; i--) this.removeEnemy(i);
    for (const p of this.projectiles) {
      if (!p.active) continue;
      p.active = false;
      p.group.visible = false;
      if (p.light) { this.vfx.releaseLight(p.light); p.light = null; }
    }
    this.pickups.clear();
    this.targets.length = 0;
    this.lastPlayer = null;
    this.primed = false;
    this.spawnT = 0;
  }

  /**
   * Back to a new game: no enemies, no drops on the ground, the starting purse.
   *
   * `setWorld` already does nine tenths of this and is called with the world it
   * already has, which is not a trick — the reason that method clears everything
   * it clears is that the population and the loose drops belong to a PLAY
   * SESSION rather than to this object, and a new game is the same event as a
   * new zone from their point of view. What it does not know about is the purse,
   * which is the one number here that a zone switch must carry across and a new
   * game must not.
   *
   * Not a rebuild, for the reason `setWorld` gives above its own body:
   * reconstructing this would throw away every warmed shader program with it.
   */
  reset(): void {
    this.setWorld(this.world);
    this.shardTotal = 50;
    this.bus.emit({ type: 'shardsChanged', total: this.shardTotal });
  }

  // ------------------------------------------------------------------ cast

  cast(req: CastRequest): void {
    const skill = req.skill;
    const hex = ELEMENT_COLORS[skill.element];
    switch (skill.targeting) {
      case 'projectile': this.castProjectile(req, hex); break;
      case 'beam': this.castBeam(req, hex); break;
      case 'aoe': this.castAoe(req, hex); break;
      case 'melee': {
        _a.set(req.direction.x, 0, req.direction.z);
        if (_a.lengthSq() < 1e-6) _a.set(req.caster.forward.x, 0, req.caster.forward.z);
        if (_a.lengthSq() < 1e-6) _a.set(0, 0, 1);
        _a.normalize();
        this.meleeArc(
          req.origin.x, req.origin.y, req.origin.z, _a.x, _a.z,
          Math.max(2.4, Math.min(3.4, skill.range)), 0.42,
          this.skillBase(skill, req.attackStat), skill.element, hex, 1.9, true,
        );
        break;
      }
      case 'self':
      case 'support':
        this.castHeal(req, hex);
        break;
    }
  }

  /** Player sword: short-range frontal arc (~100 degrees, ~2.2 units). */
  meleeStrike(origin: THREE.Vector3, direction: THREE.Vector3, attackStat: number): void {
    _a.set(direction.x, 0, direction.z);
    if (_a.lengthSq() < 1e-6) return;
    _a.normalize();
    this.meleeArc(
      origin.x, origin.y, origin.z, _a.x, _a.z,
      SWORD_REACH, SWORD_ARC_COS, attackStat * 1.2, undefined, 0xdfe9ff, 1.6, false,
    );
  }

  /**
   * The wild enemy nearest the CROSSHAIR that a sword swing could actually
   * reach, or null if there is nothing worth steering at.
   *
   * The query behind the melee aim assist. It exists on the combat system
   * rather than in main.ts for the one reason a query ever moves: the enemy
   * list is here. The POLICY — how wide the assist looks, and what it does with
   * the answer — stays in the composition root, which is where the sword's
   * swing direction is decided.
   *
   * TWO TESTS, both anchored at the HERO, both against the crosshair's bearing:
   *
   *  - REACH uses the identical `reach + radius` comparison `meleeArc` runs a
   *    few lines below. An assist that could pick a target the swing cannot
   *    land on is worse than no assist at all — it would steer the arc AWAY
   *    from something it would have hit, toward something it cannot. Same
   *    number, same source (`SWORD_REACH`), so the two cannot drift apart.
   *  - NEAREST THE CROSSHAIR is the angle between where the player is aiming
   *    (`aim`, the camera's forward — the crosshair is pinned to the centre of
   *    the viewport, which tools/test-crosshair.mjs proves pixel-wise) and the
   *    bearing from the HERO to the enemy. It both ranks the candidates and
   *    bounds them, via `coneCos`.
   *
   * MEASURING THAT ANGLE AT THE LENS INSTEAD IS A TRAP, and it is worth the
   * paragraph because it is the more obvious reading of "closest to the
   * crosshair". The camera sits about four units behind the hero, so an enemy
   * standing at his SHOULDER — 1.3 units away, 120 degrees off his facing — was
   * measured at 3.75 degrees off the crosshair: all but centred on screen,
   * because it is nearly in line with a lens that far back. Ranked and gated
   * that way the assist selected it and would have spun the swing 164.9
   * degrees, very nearly backwards. Anchored at the hero the same enemy reads
   * 120 degrees and is refused. The angle a swing has to travel is subtended at
   * the shoulders, not at the lens.
   *
   * Both are flattened to the XZ plane. That is not an approximation of a 3D
   * test, it is the right test: `meleeArc` cuts a horizontal wedge and has no
   * vertical term at all, so "which enemy is this swing meant for" is a
   * question about bearing. It also avoids inventing a torso height for
   * `Damageable`, which publishes a position and no bounds.
   */
  bestMeleeTarget(
    from: THREE.Vector3,
    aim: THREE.Vector3,
    reach: number,
    coneCos: number,
  ): Damageable | null {
    const al = Math.hypot(aim.x, aim.z);
    // Looking straight down the Y axis: there is no bearing to be near.
    if (al < 1e-6) return null;
    const ux = aim.x / al;
    const uz = aim.z / al;

    let best: Enemy | null = null;
    // Seeded with the cone, so "outside the cone" and "no enemies" are one
    // branch and the loop never keeps a candidate it would then have to reject.
    let bestDot = coneCos;
    for (const e of this.enemies) {
      if (e.isDead) continue;
      const rx = e.position.x - from.x;
      const rz = e.position.z - from.z;
      const rd = Math.sqrt(rx * rx + rz * rz);
      if (rd > reach + e.radius) continue;
      // Standing inside the target: no bearing, and the arc hits it from
      // wherever it swings.
      if (rd < 1e-4) continue;
      const dot = (rx / rd) * ux + (rz / rd) * uz;
      if (dot > bestDot) { bestDot = dot; best = e; }
    }
    return best;
  }

  findNearestEnemy(pos: THREE.Vector3, range: number): Damageable | null {
    let best: Damageable | null = null;
    let bd = range * range;
    for (const e of this.enemies) {
      if (e.isDead) continue;
      const dx = e.position.x - pos.x;
      const dy = e.position.y - pos.y;
      const dz = e.position.z - pos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bd) { bd = d2; best = e; }
    }
    return best;
  }

  // ----------------------------------------------------------------- drops

  /** Put an item on the ground (enemy loot, and the fetch test hook in main). */
  spawnDrop(itemId: string, x: number, y: number, z: number): void {
    this.pickups.spawn(x, y, z, itemId);
  }

  /**
   * Offer the nearest fetchable drop near `from`. `want` is the caller's
   * policy — combat has no opinion on which items are worth a trip.
   */
  findFetchJob(from: THREE.Vector3, maxDist: number, want: (itemId: string) => boolean): FetchJob | null {
    return this.pickups.findJob(from, maxDist, want);
  }

  /** Debug read-out of everything lying on the ground. Allocates. */
  dropSnapshot(): { itemId: string; x: number; z: number; claimed: boolean; age: number }[] {
    return this.pickups.snapshot();
  }

  // ---------------------------------------------------------------- update

  update(dt: number, player: Damageable, friendlies: Damageable[]): void {
    this.time += dt;
    this.enemyCtx.time = this.time;
    this.lastPlayer = player;

    this.targets.length = 0;
    if (!player.isDead) this.targets.push(player);
    for (const f of friendlies) if (!f.isDead) this.targets.push(f);

    // ------------------------------------------------------------ spawner
    // `enemies=0` suppresses the whole population, initial priming included, so
    // a measurement run can price the wild spawns (see core/flags.ts).
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
        if (this.enemies.length < SPAWN_MAX) this.trySpawn(player.position, false);
      }
    }

    // ------------------------------------------------------------ enemies
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      e.update(dt, this.enemyCtx);
      if (e.isDead) { this.killEnemy(e, i); continue; }
      const dx = e.position.x - player.position.x;
      const dz = e.position.z - player.position.z;
      if (dx * dx + dz * dz > DESPAWN_DIST_SQ) this.removeEnemy(i);
    }

    this.updateProjectiles(dt);
    this.pickups.update(dt, player.position, this.world);
    this.vfx.update(dt);
    this.numbers.update(dt);
  }

  // -------------------------------------------------------------- helpers

  private skillBase(skill: SkillDef, attackStat: number): number {
    return skill.power * (attackStat / 10);
  }

  /**
   * Apply damage to an enemy: element multiplier, 10% crit at 1.5x, floating
   * damage number and an element-colored hit pop.
   */
  private dealSkillDamage(
    enemy: Enemy, rawBase: number, element: ElementType | undefined,
    fromX: number, fromY: number, fromZ: number, bySkill: boolean,
  ): void {
    const mult = elementMultiplier(element, enemy.element);
    const crit = Math.random() < CRIT_CHANCE;
    const dmg = Math.max(1, Math.round(rawBase * mult * (crit ? CRIT_MULT : 1)));
    _from.set(fromX, fromY, fromZ);
    if (!enemy.takeDamage(dmg, _from, element)) return;
    const hex = crit ? CRIT_HEX : element ? ELEMENT_COLORS[element] : 0xf2f6ff;
    const px = enemy.position.x, py = enemy.position.y, pz = enemy.position.z;
    this.numbers.spawn(px, py + enemy.height + 0.35, pz, String(dmg), hex, crit);
    this.vfx.burst(px, py + enemy.height * 0.5, pz, hex, crit ? 14 : 8, 3.6, 0.32, 0.22, -2, 0.4);
    if (mult > 1) this.vfx.glowPulse(px, py + enemy.height * 0.5, pz, hex, 1.6, 0.22);
    this.bus.emit({
      type: 'hitDealt',
      amount: dmg,
      crit,
      superEffective: mult > 1,
      element,
      bySkill,
      x: px, y: py + enemy.height * 0.5, z: pz,
    });
  }

  /**
   * Enemy -> player/beast hit (EnemyCtx callback).
   *
   * Everything below the gate is CONDITIONAL on the hit having landed, which it
   * did not used to be. `Player.takeDamage` has always refused hits inside its
   * 0.35 s invulnerability window, but this function could not see that, so an
   * absorbed hit still spawned a damage number, a burst and a red screen flash —
   * the player was told they took damage they did not take, and a snortle
   * grinding along a wall next to them strobed the screen. Cosmetically that was
   * survivable. It stopped being survivable when the same moment started driving
   * a controller's motors.
   */
  private onEnemyHit(
    target: Damageable, amount: number, element: ElementType,
    fromX: number, fromY: number, fromZ: number,
  ): void {
    const dmg = Math.max(1, Math.round(amount));
    _from.set(fromX, fromY, fromZ);
    if (!target.takeDamage(dmg, _from, element)) return;
    const px = target.position.x, py = target.position.y, pz = target.position.z;
    this.numbers.spawn(px, py + 1.5, pz, String(dmg), 0xff6b57, false);
    this.vfx.burst(px, py + 0.9, pz, ELEMENT_COLORS[element], 9, 3.2, 0.32, 0.2, -2, 0.4);
    if (target === this.lastPlayer) this.vfx.screenFlash(0xff3822, 0.14);
  }

  /** Frontal-arc melee shared by skill melee and the player's sword. */
  private meleeArc(
    ox: number, oy: number, oz: number, dx: number, dz: number,
    reach: number, arcCos: number, rawBase: number,
    element: ElementType | undefined, hex: number, slashScale: number,
    bySkill: boolean,
  ): void {
    this.vfx.slash(ox + dx * 1.05, oy + 0.15, oz + dz * 1.05, dx, dz, hex, slashScale);
    this.vfx.flashLight(ox + dx * 1.1, oy + 0.5, oz + dz * 1.1, hex, 2.4, 5, 0.14);
    for (const e of this.enemies) {
      if (e.isDead) continue;
      const ex = e.position.x - ox;
      const ez = e.position.z - oz;
      const d = Math.sqrt(ex * ex + ez * ez);
      if (d > reach + e.radius) continue;
      if (d > 0.2 && (ex / d) * dx + (ez / d) * dz < arcCos) continue;
      // dealSkillDamage's knockback pushes away from (ox,oz) — the small shove
      this.dealSkillDamage(e, rawBase, element, ox, oy, oz, bySkill);
    }
  }

  // ----------------------------------------------------------- projectile

  private projSlot(): Projectile | null {
    for (const p of this.projectiles) if (!p.active) return p;
    if (this.projectiles.length >= PROJ_CAP) return null;
    const shellMat = new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const glowMat = new THREE.SpriteMaterial({
      map: this.vfx.glowTexture, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const group = new THREE.Group();
    const glow = new THREE.Sprite(glowMat);
    glow.scale.setScalar(1.45);
    const shell = new THREE.Mesh(this.projShellGeo, shellMat);
    const core = new THREE.Mesh(this.projCoreGeo, coreMat);
    glow.renderOrder = 21; shell.renderOrder = 22; core.renderOrder = 23;
    group.add(glow);
    group.add(shell);
    group.add(core);
    group.visible = false;
    this.scene.add(group);
    const p: Projectile = {
      active: false, group, shellMat, glowMat, light: null,
      vel: new THREE.Vector3(), target: null, element: 'fire',
      rawBase: 0, life: 0, trailT: 0, hex: 0xffffff, spin: 0, homing: 1,
    };
    this.projectiles.push(p);
    return p;
  }

  private castProjectile(req: CastRequest, hex: number): void {
    const p = this.projSlot();
    if (!p) return;
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
    p.vel.copy(req.direction).normalize().multiplyScalar(PROJ_SPEED);
    p.group.position.copy(req.origin).addScaledVector(req.direction, 0.45);
    p.shellMat.color.setHex(hex);
    p.glowMat.color.setHex(hex);
    p.group.visible = true;
    p.light = this.vfx.acquireLight(hex, 3.2, 7);
    if (p.light) p.light.position.copy(p.group.position);
    // muzzle pop
    this.vfx.glowPulse(req.origin.x, req.origin.y, req.origin.z, hex, 1.1, 0.2);
    this.vfx.burst(req.origin.x, req.origin.y, req.origin.z, hex, 7, 2.2, 0.28, 0.18, 0, 0.3);
  }

  /**
   * Shader warm-up (see warmUpShaders() in main.ts). Puts one of everything
   * this system can draw in front of `at`: a live projectile with its glow and
   * light, a damage number, a shard pickup, and the whole VFX set. `lights`
   * additionally raises the visible point-light count, which is its own program
   * key — see VFX.warmUpLights.
   */
  /** One more visible point light, for the count sweep. See VFX.warmUpLights. */
  warmUpLight(at: THREE.Vector3): void {
    this.vfx.warmUpLights(at.x, at.y, at.z, 1);
  }

  /**
   * Put one dropped shard in front of `at` for a warm-up render, and take it
   * away again afterwards. Its three materials (additive mesh, core, glow
   * sprite) are drawn nowhere else, so a zone that has never seen a drop links
   * them the first time something dies in it — measured, three programs on the
   * arrival frame. See Pickups.warmUpDrop.
   */
  warmUpDrop(at: THREE.Vector3): void {
    this.pickups.warmUpDrop(at.x, at.y + 0.4, at.z);
  }

  endWarmUpDrop(): void {
    this.pickups.retireWarmUpDrop();
  }

  /**
   * The whole VFX set, with no light and no projectile, for a zone's warm-up
   * sweep — the effect materials have to be drawn at the destination's light
   * counts too, and several of them (the ring, the beam, the scorch decal) are
   * textured MeshBasics whose programs are keyed separately from everything
   * else's.
   *
   * Staged 0.8 UNDER the point given, i.e. inside the floor. A program is
   * linked when its material is bound for a draw, not when its fragments
   * survive the depth test, so burying the burst costs nothing — and it is what
   * stops the sweep from leaving a scorch decal (7 s of life) on the pad the
   * hero is about to walk out onto.
   */
  warmUpEffects(at: THREE.Vector3): void {
    this.vfx.warmUp(at.x, at.y - 0.8, at.z);
  }

  warmUp(at: THREE.Vector3, lights: number): void {
    const p = this.projSlot();
    if (p) {
      p.active = true;
      p.element = 'fire';
      p.hex = 0xffffff;
      p.rawBase = 0;
      p.target = null;
      p.life = 0.05;
      p.trailT = 0;
      p.spin = 0;
      p.vel.set(0, 0, 0);
      p.group.position.copy(at);
      p.group.visible = true;
      p.light = this.vfx.acquireLight(0xffffff, 0.001, 4);
      if (p.light) p.light.position.copy(at);
    }
    this.numbers.spawn(at.x, at.y + 1, at.z, '1', 0xffffff, true);
    this.pickups.spawn(at.x, at.y, at.z);
    this.vfx.warmUp(at.x, at.y, at.z);
    this.vfx.warmUpLights(at.x, at.y, at.z, lights);
  }

  private updateProjectiles(dt: number): void {
    for (const p of this.projectiles) {
      if (!p.active) continue;
      p.life -= dt;
      const pos = p.group.position;
      if (p.life <= 0) {
        this.explodeProjectile(p, pos.x, pos.y, pos.z, null);
        continue;
      }
      // slight homing
      const t = p.target;
      if (t && !t.isDead) {
        _leaf.set(
          t.position.x - pos.x,
          t.position.y + 0.55 - pos.y,
          t.position.z - pos.z,
        );
        if (_leaf.lengthSq() > 1e-4) {
          _leaf.normalize().multiplyScalar(PROJ_SPEED);
          // 3.4 is full lock-on; scaled down, the shot merely leans (see
          // CastRequest.homingScale).
          p.vel.lerp(_leaf, Math.min(1, 3.4 * p.homing * dt)).setLength(PROJ_SPEED);
        }
      }
      pos.addScaledVector(p.vel, dt);
      p.spin += dt * 9;
      p.group.rotation.set(p.spin * 0.7, p.spin, p.spin * 0.45);
      if (p.light) p.light.position.copy(pos);
      p.trailT -= dt;
      while (p.trailT <= 0) {
        p.trailT += 0.022;
        this.vfx.trail(pos.x, pos.y, pos.z, p.hex, 0.3);
      }
      // enemy collision
      let hit: Enemy | null = null;
      for (const e of this.enemies) {
        if (e.isDead) continue;
        const dx = e.position.x - pos.x;
        const dy = e.position.y + e.height * 0.5 - pos.y;
        const dz = e.position.z - pos.z;
        const rr = e.radius + 0.5;
        if (dx * dx + dy * dy + dz * dz < rr * rr) { hit = e; break; }
      }
      if (hit) {
        this.explodeProjectile(p, pos.x, pos.y, pos.z, hit);
        continue;
      }
      // terrain
      const gy = this.world.getHeight(pos.x, pos.z);
      if (pos.y <= gy + 0.1) {
        pos.y = gy + 0.1;
        this.explodeProjectile(p, pos.x, pos.y, pos.z, null);
      }
    }
  }

  private explodeProjectile(p: Projectile, x: number, y: number, z: number, direct: Enemy | null): void {
    p.active = false;
    p.group.visible = false;
    if (p.light) { this.vfx.releaseLight(p.light); p.light = null; }
    this.vfx.burst(x, y, z, p.hex, 26, 6.5, 0.5, 0.32, -4, 0.5);
    this.vfx.glowPulse(x, y, z, p.hex, 2.4, 0.28);
    this.vfx.flashLight(x, y, z, p.hex, 6, 9, 0.26);
    const gy = this.world.getHeight(x, z);
    this.vfx.ring(x, gy, z, p.hex, 1.9, 0.45);
    if (y - gy < 1.2) this.vfx.scorch(x, gy, z, p.hex, 1.1);
    if (direct) this.dealSkillDamage(direct, p.rawBase, p.element, x, y, z, true);
    // small splash around the blast
    for (const e of this.enemies) {
      if (e.isDead || e === direct) continue;
      const dx = e.position.x - x;
      const dz = e.position.z - z;
      const rr = 1.9 + e.radius;
      if (dx * dx + dz * dz < rr * rr) {
        this.dealSkillDamage(e, p.rawBase * 0.55, p.element, x, y, z, true);
      }
    }
  }

  // ----------------------------------------------------------------- beam

  private castBeam(req: CastRequest, hex: number): void {
    const range = Math.max(6, req.skill.range);
    _a.copy(req.direction).normalize();
    let best: Enemy | null = null;
    let bestT = range;
    for (const e of this.enemies) {
      if (e.isDead) continue;
      _b.set(
        e.position.x - req.origin.x,
        e.position.y + e.height * 0.5 - req.origin.y,
        e.position.z - req.origin.z,
      );
      const t = _b.dot(_a);
      if (t < 0.5 || t > bestT) continue;
      const perp2 = _b.lengthSq() - t * t;
      const rr = e.radius + 0.55;
      if (perp2 < rr * rr) { bestT = t; best = e; }
    }
    _b.copy(req.origin).addScaledVector(_a, bestT);
    this.vfx.beam(req.origin, _b, hex);
    this.vfx.glowPulse(
      req.origin.x + _a.x * 0.5, req.origin.y + _a.y * 0.5, req.origin.z + _a.z * 0.5,
      hex, 1.0, 0.18,
    );
    this.vfx.burst(_b.x, _b.y, _b.z, hex, best ? 20 : 10, 5, 0.4, 0.28, -2, 0.5);
    this.vfx.flashLight(_b.x, _b.y, _b.z, hex, 5, 8, 0.22);
    // sparkle motes along the beam path
    const steps = Math.min(14, Math.floor(bestT / 0.9));
    for (let i = 1; i <= steps; i++) {
      const d = (bestT * i) / (steps + 1);
      this.vfx.trail(
        req.origin.x + _a.x * d, req.origin.y + _a.y * d, req.origin.z + _a.z * d,
        hex, 0.28,
      );
    }
    if (best) {
      this.dealSkillDamage(
        best, this.skillBase(req.skill, req.attackStat), req.skill.element,
        req.origin.x, req.origin.y, req.origin.z, true,
      );
    }
  }

  // ------------------------------------------------------------------ aoe

  private castAoe(req: CastRequest, hex: number): void {
    const skill = req.skill;
    const t = req.target;
    if (t && !t.isDead) _a.copy(t.position);
    else _a.copy(req.origin).addScaledVector(req.direction, Math.max(3, skill.range * 0.6));
    const gy = this.world.getHeight(_a.x, _a.z);
    const cx = _a.x, cz = _a.z;
    const radius = 3.1;
    this.vfx.ring(cx, gy, cz, hex, radius + 0.7, 0.55);
    this.vfx.ring(cx, gy, cz, hex, radius * 0.55, 0.38);
    this.vfx.rise(cx, gy, cz, hex, 30, radius * 0.75, 3.6, 0.85, 0.42, 2.6);
    this.vfx.burst(cx, gy + 0.5, cz, hex, 22, 5.5, 0.5, 0.3, -3, 0.8);
    this.vfx.scorch(cx, gy, cz, hex, radius * 0.8);
    this.vfx.flashLight(cx, gy + 1.2, cz, hex, 6.5, 11, 0.32);
    this.vfx.screenFlash(hex, 0.06);
    const base = this.skillBase(skill, req.attackStat);
    for (const e of this.enemies) {
      if (e.isDead) continue;
      const dx = e.position.x - cx;
      const dz = e.position.z - cz;
      const rr = radius + e.radius;
      if (dx * dx + dz * dz < rr * rr) {
        this.dealSkillDamage(e, base, skill.element, cx, gy + 0.4, cz, true);
      }
    }
  }

  // ----------------------------------------------------------------- heal

  private castHeal(req: CastRequest, hex: number): void {
    const skill = req.skill;
    // caster swirl
    this.vfx.rise(req.origin.x, req.origin.y - 0.6, req.origin.z, hex, 14, 0.65, 2.0, 0.8, 0.4, 3.2);
    // heal the most-hurt friendly (player + beasts from the last update)
    let best: Damageable | null = null;
    let bestRatio = 0.999;
    for (const f of this.targets) {
      const r = f.hp / Math.max(1, f.maxHp);
      if (r < bestRatio) { bestRatio = r; best = f; }
    }
    if (!best) return;
    const heal = Math.max(1, Math.round(skill.power));
    best.hp = Math.min(best.maxHp, best.hp + heal);
    const px = best.position.x, py = best.position.y, pz = best.position.z;
    const gy = this.world.getHeight(px, pz);
    this.vfx.rise(px, gy, pz, hex, 26, 0.9, 2.6, 0.95, 0.5, 3.6);
    this.vfx.ring(px, gy, pz, hex, 1.7, 0.5);
    this.vfx.glowPulse(px, py + 1.0, pz, hex, 1.8, 0.35);
    this.vfx.flashLight(px, py + 1.2, pz, hex, 3, 7, 0.4);
    this.numbers.spawn(px, py + 1.8, pz, `+${heal}`, 0x8cf59a, false);
  }

  // ------------------------------------------------------------- spawning

  private trySpawn(center: THREE.Vector3, silent: boolean): void {
    // UNIFORM OVER WHATEVER CONTENT LOADED, exactly as it was uniform over the
    // three entries of `ENEMY_DEFS`. The list is the roster's own cached frozen
    // view (see `enemySpecies`), so this is a read and not a rebuild — a spawn
    // path may not allocate a table. An empty roster is a world with no wild
    // population, which is what `?enemies=0` already produces.
    const defs = enemySpecies();
    if (defs.length === 0) return;
    const def = defs[(Math.random() * defs.length) | 0];
    const a = Math.random() * Math.PI * 2;
    const r = SPAWN_RING_MIN + Math.random() * (SPAWN_RING_MAX - SPAWN_RING_MIN);
    const x = center.x + Math.cos(a) * r;
    const z = center.z + Math.sin(a) * r;
    const sp = this.world.spawnPoint;
    const sx = x - sp.x, sz = z - sp.z;
    if (sx * sx + sz * sz < SAFE_ZONE_SQ) return;
    if (!def.flying && this.world.isWater(x, z)) return;
    const gy = this.world.getHeight(x, z);
    const variant = variantForHeight(gy - this.world.waterLevel);
    const e = new Enemy(def.id, variant, x, z, this.world);
    this.scene.add(e.root);
    this.enemies.push(e);
    perf.count('enemies');
    if (!silent) {
      const hex = ELEMENT_COLORS[e.element];
      this.vfx.dust(x, gy + 0.06, z, 12);
      this.vfx.ring(x, gy, z, hex, 1.5, 0.5);
      this.vfx.glowPulse(x, gy + 0.6, z, hex, 1.6, 0.3);
    }
  }

  private killEnemy(e: Enemy, i: number): void {
    const px = e.position.x, py = e.position.y, pz = e.position.z;
    const gy = this.world.getHeight(px, pz);
    const hex = ELEMENT_COLORS[e.element];
    // satisfying voxel pop
    this.vfx.debrisBurst(px, py + e.height * 0.5, pz, e.palette, 14, 5.5, 0.14, gy);
    this.vfx.burst(px, py + e.height * 0.5, pz, hex, 26, 6.5, 0.55, 0.32, -4, 0.6);
    this.vfx.ring(px, gy, pz, hex, 2.2, 0.5);
    this.vfx.glowPulse(px, py + e.height * 0.5, pz, hex, 2.4, 0.32);
    this.vfx.flashLight(px, py + 0.8, pz, hex, 5, 9, 0.3);
    const xp = e.xp + ((Math.random() * 5) | 0);
    this.bus.emit({ type: 'enemyKilled', nameKey: e.nameKey, xp });
    const drops = 1 + ((Math.random() * 3) | 0);
    for (let k = 0; k < drops; k++) this.pickups.spawn(px, py + 0.6, pz, SHARD_ID);
    // Stackable loot on top of the shards. 1-in-4 is a first pass, chosen to be
    // frequent enough that both item kinds turn up in ordinary play and rare
    // enough that the ground does not fill with cubes the support beast is under
    // orders to ignore. Retune once there is something to spend them on.
    if (Math.random() < 0.25) {
      const id = STACKABLE_IDS[(Math.random() * STACKABLE_IDS.length) | 0];
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
}
