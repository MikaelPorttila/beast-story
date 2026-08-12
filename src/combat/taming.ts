import * as THREE from "three";
import type { ItemDef } from "../core/types";
import type { Enemy } from "./enemies";
import type { VFX } from "./vfx";
import { tameOrbMesh, LANDED_SCALE, ORB_RADIUS } from "./tame-orb";

// Bonding a wild beast. The outcome is decided the instant the orb lands; the
// wobbles only PLAY it. A failed bond hands the animal back provoked at the same
// health (`Enemy.setHeld`) — never through the death path, which pays loot + xp.

// Base odds by `ItemDef.orbTier` (slot 0 unused). Steps are ~x1.9, so a better
// orb is worth buying but never worth buying INSTEAD of fighting.
const ORB_BASE = [0, 0.12, 0.23, 0.42, 0.72];

// Multiplier at zero health — makes health the dominant term. Linear in MISSING
// health, so the player reads it off the hp bar.
const WEAKEN_MAX = 4;

// No tier gate (issue #110): a weak orb on a hard beast is a long shot, never a
// refusal, and the player is shown the number before throwing.
const MIN_CHANCE = 0.03;
const MAX_CHANCE = 0.95;

/**
 * Odds, 0..1 — 0 when the beast is not bondable. Exported so the HUD prompt
 * shows the same number `begin` rolls against; a second copy could lie.
 */
export function captureChance(orb: ItemDef, target: Enemy): number {
  const rule = target.capture;
  if (!rule) {
    return 0;
  }
  const tier = orb.orbTier ?? 0;
  const hpFrac = target.maxHp > 0 ? Math.max(0, Math.min(1, target.hp / target.maxHp)) : 1;
  const weaken = 1 + (WEAKEN_MAX - 1) * (1 - hpFrac);
  const p = ((ORB_BASE[tier] ?? 0) * weaken) / rule.difficulty;
  return Math.max(MIN_CHANCE, Math.min(MAX_CHANCE, p));
}

export type ThrowRefusal = "ok" | "notBondable" | "busy";

// Checked by main.ts BEFORE the orb leaves the hand, so a wasted throw gets a
// message rather than a bounce two seconds later.
export function refuseThrow(_orb: ItemDef, target: Enemy | null): ThrowRefusal {
  if (!target || !target.capture) {
    return "notBondable";
  }
  if (target.held) {
    return "busy";
  }
  return "ok";
}

const SUCK_SECONDS = 0.45;
const WOBBLE_SECONDS = 0.5;
const WOBBLES = 3;

const WOBBLE_TILT = 0.55;

// Resting centre height: the model is built centred, so this is its own radius
// at landed scale. Derived, never written out — both constants have moved.
const ORB_REST = ORB_RADIUS * LANDED_SCALE;

interface Ceremony {
  active: boolean;
  target: Enemy;
  orb: ItemDef;
  caught: boolean;
  /** Seconds since the orb landed. */
  t: number;
  wobblesDone: number;
  mesh: THREE.Object3D;
  at: THREE.Vector3;
}

export type TameSettled = (target: Enemy, orb: ItemDef, caught: boolean) => void;
export type TameWobbled = (index: number, of: number) => void;

export class Taming {
  private slots: Ceremony[] = [];

  constructor(
    private readonly scene: THREE.Scene,
    private readonly vfx: VFX,
    private readonly onSettled: TameSettled,
    private readonly onWobble: TameWobbled,
  ) {}

  /** True while any bond plays — what `__dbgTaming` reports. */
  get busy(): boolean {
    return this.slots.some((s) => s.active);
  }

  /** Returns the chance rolled against; the outcome stays private until settle. */
  begin(orb: ItemDef, target: Enemy, force?: boolean): number {
    const chance = captureChance(orb, target);
    // `force` is a test hook only (`__dbgThrowOrb`), so a probe can assert both
    // settle paths without rolling dice.
    const caught = force ?? Math.random() < chance;
    const slot = this.slot();
    slot.active = true;
    slot.target = target;
    slot.orb = orb;
    slot.caught = caught;
    slot.t = 0;
    slot.wobblesDone = 0;
    slot.at.copy(target.position);

    // Hidden NOW, not at the end of the suck-in: it is inside the orb the
    // moment the glass touches it.
    target.setHeld(true);

    const p = slot.at;
    this.vfx.rise(
      p.x,
      p.y + 0.1,
      p.z,
      orb.color,
      26,
      target.radius + 0.5,
      2.4,
      SUCK_SECONDS + 0.2,
      0.22,
      7,
    );
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
      if (!s.active) {
        continue;
      }
      s.t += dt;

      if (s.t < SUCK_SECONDS) {
        const k = s.t / SUCK_SECONDS;
        s.mesh.position.y = s.at.y + ORB_REST + (1 - k) * 0.9;
        s.mesh.rotation.z = (1 - k) * 6;
        continue;
      }

      // Wobbles: each fires its cue on the way in, so haptics match the picture.
      const w = (s.t - SUCK_SECONDS) / WOBBLE_SECONDS;
      const done = Math.min(WOBBLES, Math.floor(w));
      if (done > s.wobblesDone && done < WOBBLES) {
        s.wobblesDone = done;
        this.onWobble(done, WOBBLES);
        this.vfx.dust(s.at.x, s.at.y + 0.05, s.at.z, 3, s.orb.color);
      }
      if (w < WOBBLES) {
        // Direction flips per wobble, or three lobes read as one shudder.
        const frac = w - Math.floor(w);
        const dir = Math.floor(w) % 2 === 0 ? 1 : -1;
        s.mesh.position.y = s.at.y + ORB_REST;
        s.mesh.rotation.z = dir * WOBBLE_TILT * Math.sin(Math.PI * frac);
        continue;
      }

      this.finish(s);
    }
  }

  private finish(s: Ceremony): void {
    s.active = false;
    s.mesh.visible = false;
    const p = s.at;
    if (s.caught) {
      this.vfx.glowPulse(p.x, p.y + ORB_REST, p.z, s.orb.color, 3.2, 0.42);
      this.vfx.burst(p.x, p.y + ORB_REST, p.z, 0xfff3c4, 34, 5.5, 0.6, 0.26, -3, 0.6);
      this.vfx.ring(p.x, p.y, p.z, s.orb.color, 2.4, 0.55);
      this.vfx.flashLight(p.x, p.y + 0.5, p.z, 0xfff3c4, 7, 10, 0.3);
    } else {
      this.vfx.debrisBurst(p.x, p.y + ORB_REST, p.z, [s.orb.color, 0xf4f7fb], 12, 4.5, 0.1, p.y);
      this.vfx.burst(p.x, p.y + ORB_REST, p.z, s.orb.color, 18, 4.5, 0.45, 0.22, -6, 0.4);
      this.vfx.ring(p.x, p.y, p.z, s.orb.color, 1.6, 0.35);
      s.target.setHeld(false);
    }
    this.onSettled(s.target, s.orb, s.caught);
  }

  // Drops every bond mid-ceremony. Beasts stay held: the caller is about to
  // drop the whole wild population anyway.
  clear(): void {
    for (const s of this.slots) {
      s.active = false;
      s.mesh.visible = false;
    }
  }

  private slot(): Ceremony {
    for (const s of this.slots) {
      if (!s.active) {
        return s;
      }
    }
    const s: Ceremony = {
      active: false,
      target: null as unknown as Enemy,
      orb: null as unknown as ItemDef,
      caught: false,
      t: 0,
      wobblesDone: 0,
      mesh: new THREE.Group(),
      at: new THREE.Vector3(),
    };
    this.slots.push(s);
    return s;
  }

  /** A slot keeps ONE mesh and swaps it when the tier's colour changes. */
  private meshFor(s: Ceremony, color: number): THREE.Object3D {
    const want = tameOrbMesh(color);
    const cur = s.mesh as THREE.Mesh;
    if (cur.parent && (cur as THREE.Mesh).geometry === (want as THREE.Mesh).geometry) {
      return s.mesh;
    }
    if (s.mesh.parent) {
      s.mesh.parent.remove(s.mesh);
    }
    const m = want.clone();
    m.scale.setScalar(LANDED_SCALE);
    this.scene.add(m);
    s.mesh = m;
    return m;
  }

  // Removes meshes only — geometry/material are shared and freed by
  // `disposeTameOrbs` in combat/tame-orb.ts.
  dispose(): void {
    for (const s of this.slots) {
      if (s.mesh.parent) {
        s.mesh.parent.remove(s.mesh);
      }
    }
    this.slots.length = 0;
  }
}
