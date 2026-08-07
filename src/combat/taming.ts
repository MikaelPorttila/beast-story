import * as THREE from 'three';
import type { ItemDef } from '../core/types';
import type { Enemy } from './enemies';
import type { VFX } from './vfx';
import { tameOrbMesh, LANDED_SCALE, ORB_RADIUS } from './tame-orb';

/**
 * BONDING A WILD BEAST: the odds, and the two seconds of theatre around them.
 *
 * ITS OWN FILE because it is a RULE, and combat/index.ts is an orchestrator. The
 * projectile pool already knows how to put an orb on a beast; what happens next
 * is a question about hit points, an orb tier and a die roll, and burying that
 * in `explodeProjectile` between a burst and a scorch decal is how a game's
 * balance ends up somewhere nobody can find it.
 *
 * THE CEREMONY IS NOT DECORATION. `captureChance` decides the outcome the
 * instant the orb lands — before the first wobble — and the theatre plays a
 * result that is already true. That is the honest way round: a wobble that
 * re-rolled would mean the odds printed on an orb were not the odds, and a
 * player who reloaded (one day) would see a different answer to the same throw.
 * What the wobbles buy is the two seconds in which the player does not know yet,
 * which is the entire feeling the mechanic is for.
 *
 * THE BEAST IS HELD, NOT KILLED. A failed bond gives the animal back at exactly
 * the health it had, provoked — see `Enemy.setHeld`. That is why this cannot be
 * written in terms of the death path: `killEnemy` pays out loot and xp and
 * fires `enemyKilled`, and a bond is none of those things.
 */

/**
 * Base odds per orb tier, before health and difficulty — index by
 * `ItemDef.orbTier`, so slot 0 is unused.
 *
 * READ WITH `captureChance` AND NOT ALONE. Against a full-health beast of
 * difficulty 1 these are the whole answer, and they are deliberately poor: 0.12
 * for a Tame Orb says "an orb is not how you defeat something", which is the
 * mechanic the issue asks for. Against the same beast at a sliver of health the
 * multiplier below is 4, so a Tame Orb is a coin flip and a Master Orb is a
 * formality.
 *
 * The steps are roughly ×1.9 rather than the price's ×4, and that gap is the
 * point of the four tiers existing: a better orb is worth buying and never worth
 * buying INSTEAD of fighting.
 */
const ORB_BASE = [0, 0.12, 0.23, 0.42, 0.72];

/**
 * How much a beaten-down beast helps, as the multiplier at zero health.
 *
 * 4 is what makes health the dominant term: at full health the multiplier is 1
 * and every orb is a long shot, at 25% it is 3.25, and at a sliver it is 4. The
 * curve between them is linear in MISSING health rather than in health, because
 * the player's read on it has to be the hp bar they are already watching.
 */
const WEAKEN_MAX = 4;

/** Nothing is ever certain, and nothing is ever impossible above the tier gate. */
const MIN_CHANCE = 0.03;
const MAX_CHANCE = 0.95;

/**
 * The odds this orb bonds this beast, 0..1 — or 0 when the orb is too weak to
 * try at all.
 *
 * EXPORTED because two callers need the same number and neither may compute it:
 * `Taming.begin` rolls against it, and the HUD's throw prompt (main.ts) shows it
 * so the player is spending an orb on a decision rather than on a hunch. A
 * second copy of the formula in the UI would be a UI that can lie.
 */
export function captureChance(orb: ItemDef, target: Enemy): number {
  const rule = target.capture;
  if (!rule) return 0;
  const tier = orb.orbTier ?? 0;
  if (tier < rule.minTier) return 0;
  const hpFrac = target.maxHp > 0 ? Math.max(0, Math.min(1, target.hp / target.maxHp)) : 1;
  const weaken = 1 + (WEAKEN_MAX - 1) * (1 - hpFrac);
  const p = (ORB_BASE[tier] ?? 0) * weaken / rule.difficulty;
  return Math.max(MIN_CHANCE, Math.min(MAX_CHANCE, p));
}

/** Why a throw was refused, or `ok` when it will actually be attempted. */
export type ThrowRefusal = 'ok' | 'notBondable' | 'orbTooWeak' | 'busy';

/**
 * Can this orb be thrown at this beast at all?
 *
 * SEPARATE FROM THE ROLL, and checked by main.ts BEFORE the orb leaves the
 * hand: an orb spent on something that was never going to work is the one
 * outcome a player is entitled to be warned about, and "it bounced off" two
 * seconds later is not a warning. The roll's own `captureChance` returning 0
 * would have been the same test, but not the same MESSAGE, and the message is
 * the whole value of doing it early.
 */
export function refuseThrow(orb: ItemDef, target: Enemy | null): ThrowRefusal {
  if (!target || !target.capture) return 'notBondable';
  if ((orb.orbTier ?? 0) < target.capture.minTier) return 'orbTooWeak';
  if (target.held) return 'busy';
  return 'ok';
}

// -- the ceremony -----------------------------------------------------------

/** Seconds the beast takes to be drawn into the orb. */
const SUCK_SECONDS = 0.45;
/** Seconds per wobble, and how many. Three, for the reason in the header. */
const WOBBLE_SECONDS = 0.5;
const WOBBLES = 3;

/** How far the orb tips at the peak of a wobble, in radians. */
const WOBBLE_TILT = 0.55;

/**
 * How high a resting orb's centre sits above the ground it landed on.
 *
 * The model is built centred (see combat/tame-orb.ts), so this is its own radius
 * at the size a landed one is drawn. DERIVED from that file's two constants
 * rather than written out here: it was `3 * 0.07 * 1.5` by hand, and it went
 * quietly wrong the moment the model was rounded off.
 */
const ORB_REST = ORB_RADIUS * LANDED_SCALE;

interface Ceremony {
  active: boolean;
  target: Enemy;
  orb: ItemDef;
  caught: boolean;
  /** Seconds elapsed since the orb landed. */
  t: number;
  /** Which wobble has been given its shake and its cue, 0..WOBBLES. */
  wobblesDone: number;
  mesh: THREE.Object3D;
  /** Where the orb sits: the beast's own feet, so it lands where it stood. */
  at: THREE.Vector3;
}

export type TameSettled = (target: Enemy, orb: ItemDef, caught: boolean) => void;
export type TameWobbled = (index: number, of: number) => void;

/**
 * Every bond in progress. There is almost always one — you cannot throw a second
 * orb at a beast that is already inside one, and two beasts at once needs two
 * throws inside two seconds — so the list is a handful of slots that get reused,
 * built the same way every other pool in this directory is.
 */
export class Taming {
  private slots: Ceremony[] = [];

  constructor(
    private readonly scene: THREE.Scene,
    private readonly vfx: VFX,
    private readonly onSettled: TameSettled,
    private readonly onWobble: TameWobbled,
  ) {}

  /** True while any bond is playing — what `__dbgTaming` reports and probes wait on. */
  get busy(): boolean {
    return this.slots.some((s) => s.active);
  }

  /**
   * The orb has landed on this beast. Roll, hide the animal, and start the show.
   *
   * Returns the chance that was rolled against, so the caller can report it —
   * the roll itself is not returned, because nothing outside may act on the
   * outcome before the ceremony has played it.
   */
  begin(orb: ItemDef, target: Enemy, force?: boolean): number {
    const chance = captureChance(orb, target);
    // `force` IS A TEST HOOK and nothing in play passes it — see `__dbgThrowOrb`
    // in main.ts. The roll is a coin flip by design, and a probe that flipped it
    // for real would be a probe that fails one run in twenty; asserting that a
    // CAUGHT bond removes the beast and grants the species, and that a BROKEN one
    // hands it back provoked, is a statement about the two settle paths and not
    // about the odds. The odds are asserted separately, off `captureChance`,
    // which is a formula and needs no dice at all.
    const caught = force ?? (Math.random() < chance);
    const slot = this.slot();
    slot.active = true;
    slot.target = target;
    slot.orb = orb;
    slot.caught = caught;
    slot.t = 0;
    slot.wobblesDone = 0;
    slot.at.copy(target.position);

    // The animal goes away NOW rather than at the end of the suck-in: it is
    // inside the orb from the moment the glass touches it, and leaving it
    // standing there for half a second while particles spiral off it reads as
    // two things happening rather than one.
    target.setHeld(true);

    // Drawn IN: a spiral of the beast's own element colour, converging on the
    // orb. `swirlSpeed` with the orb as the centre is what makes it a vortex
    // rather than a puff — see `Particles.spawn` in combat/vfx.ts.
    const p = slot.at;
    this.vfx.rise(p.x, p.y + 0.1, p.z, orb.color, 26, target.radius + 0.5, 2.4, SUCK_SECONDS + 0.2, 0.22, 7);
    this.vfx.glowPulse(p.x, p.y + 0.4, p.z, orb.color, 2.2, 0.3);
    this.vfx.flashLight(p.x, p.y + 0.5, p.z, orb.color, 4, 7, 0.3);

    slot.mesh = this.meshFor(slot, orb.color);
    slot.mesh.visible = true;
    slot.mesh.position.set(p.x, p.y + ORB_REST, p.z);
    slot.mesh.rotation.set(0, 0, 0);
    return chance;
  }

  update(dt: number): void {
    for (const s of this.slots) {
      if (!s.active) continue;
      s.t += dt;

      // 1. The suck-in. The orb hangs where the beast stood and settles down to
      //    the ground as the animal comes in — it is being filled, and a thing
      //    being filled gets heavier.
      if (s.t < SUCK_SECONDS) {
        const k = s.t / SUCK_SECONDS;
        s.mesh.position.y = s.at.y + ORB_REST + (1 - k) * 0.9;
        s.mesh.rotation.z = (1 - k) * 6;
        continue;
      }

      // 2. The wobbles. Each one is a tip one way and back, and each one fires
      //    its cue on the way in so the controller shakes with the picture.
      const w = (s.t - SUCK_SECONDS) / WOBBLE_SECONDS;
      const done = Math.min(WOBBLES, Math.floor(w));
      if (done > s.wobblesDone && done < WOBBLES) {
        s.wobblesDone = done;
        this.onWobble(done, WOBBLES);
        this.vfx.dust(s.at.x, s.at.y + 0.05, s.at.z, 3, s.orb.color);
      }
      if (w < WOBBLES) {
        // Alternating direction per wobble, easing out within each — a rock,
        // not a shiver. `sin(pi * frac)` is one lobe, and the sign flip is what
        // stops three wobbles reading as one long shudder.
        const frac = w - Math.floor(w);
        const dir = Math.floor(w) % 2 === 0 ? 1 : -1;
        s.mesh.position.y = s.at.y + ORB_REST;
        s.mesh.rotation.z = dir * WOBBLE_TILT * Math.sin(Math.PI * frac);
        continue;
      }

      // 3. The answer.
      this.finish(s);
    }
  }

  private finish(s: Ceremony): void {
    s.active = false;
    s.mesh.visible = false;
    const p = s.at;
    if (s.caught) {
      // Kept: the orb closes for good. A ring on the ground and a bright pop,
      // in the ORB's colour rather than the beast's — what just happened is a
      // thing the orb did.
      this.vfx.glowPulse(p.x, p.y + ORB_REST, p.z, s.orb.color, 3.2, 0.42);
      this.vfx.burst(p.x, p.y + ORB_REST, p.z, 0xfff3c4, 34, 5.5, 0.6, 0.26, -3, 0.6);
      this.vfx.ring(p.x, p.y, p.z, s.orb.color, 2.4, 0.55);
      this.vfx.flashLight(p.x, p.y + 0.5, p.z, 0xfff3c4, 7, 10, 0.3);
    } else {
      // Broke: the glass goes, and the animal comes back out of it. The debris
      // is the ORB's colour because it is the orb that shattered.
      this.vfx.debrisBurst(p.x, p.y + ORB_REST, p.z, [s.orb.color, 0xf4f7fb], 12, 4.5, 0.1, p.y);
      this.vfx.burst(p.x, p.y + ORB_REST, p.z, s.orb.color, 18, 4.5, 0.45, 0.22, -6, 0.4);
      this.vfx.ring(p.x, p.y, p.z, s.orb.color, 1.6, 0.35);
      s.target.setHeld(false);
    }
    this.onSettled(s.target, s.orb, s.caught);
  }

  /**
   * Give every bond back, mid-ceremony — a zone change or a new game.
   *
   * The beasts are NOT handed back: `CombatSystem.setWorld` is about to drop the
   * whole wild population, and `reset` is a new game. Un-holding them here would
   * be un-holding something that is being thrown away, and the one case that
   * matters — the player walked through a portal while an orb was wobbling — is
   * a bond that did not happen rather than one that failed.
   */
  clear(): void {
    for (const s of this.slots) {
      s.active = false;
      s.mesh.visible = false;
    }
  }

  private slot(): Ceremony {
    for (const s of this.slots) if (!s.active) return s;
    const s: Ceremony = {
      active: false, target: null as unknown as Enemy, orb: null as unknown as ItemDef,
      caught: false, t: 0, wobblesDone: 0,
      mesh: new THREE.Group(), at: new THREE.Vector3(),
    };
    this.slots.push(s);
    return s;
  }

  /**
   * The orb model this ceremony shows, at this colour.
   *
   * A slot keeps ONE mesh and swaps it when the tier changes, unlike the
   * projectile pool's per-colour map: a ceremony runs for two seconds and there
   * is almost never a second one, so the map that pays off across hundreds of
   * throws would here be a cache with one entry in it.
   */
  private meshFor(s: Ceremony, color: number): THREE.Object3D {
    const want = tameOrbMesh(color);
    const cur = s.mesh as THREE.Mesh;
    if (cur.parent && (cur as THREE.Mesh).geometry === (want as THREE.Mesh).geometry) return s.mesh;
    if (s.mesh.parent) s.mesh.parent.remove(s.mesh);
    const m = want.clone();
    m.scale.setScalar(LANDED_SCALE);
    this.scene.add(m);
    s.mesh = m;
    return m;
  }

  /**
   * Take the ceremony meshes off the scene.
   *
   * The GEOMETRY and MATERIAL are not freed here — they are shared with the
   * projectile pool's clones and owned by `disposeTameOrbs` in
   * combat/tame-orb.ts, which combat/index.ts calls once.
   */
  dispose(): void {
    for (const s of this.slots) {
      if (s.mesh.parent) s.mesh.parent.remove(s.mesh);
    }
    this.slots.length = 0;
  }
}

