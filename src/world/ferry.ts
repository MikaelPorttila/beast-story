/**
 * THE FERRY: a scripted ride between two stops of the SAME world. Act 2 is part
 * of the open world (issue #144) — there is no zone and no instance behind this,
 * only a crossing the hero cannot yet make himself. `sea-revealed` moors the
 * boats; the water mount later makes them optional. Act 3's balloon (issue #157)
 * is the same ride with a different craft, and one of its stops RIDES A CARRIER:
 * a framed stop's coordinates are local to that frame and resolved every slice.
 *
 * The press rules are the Gateway's, deliberately: standing on the pier is not
 * sailing, the PRESS is the ask, and the pad you LAND on is disarmed until you
 * walk off it — or the same key that brought you bounces you straight back.
 * The numbers quote the gateway pair (ENTER_R/EXIT_R, GATE_RISE) for the same
 * hysteresis reasons; see zones.ts.
 *
 * The craft models are placeholders — issue #228 builds the real harbour kit
 * (quays, deck bridges, ships); these exist so a moored craft MARKS the crossing.
 */
import * as THREE from "three";
import { inRise, type LocalFrame } from "../core/types";
import type { StringKey } from "../i18n";

export interface FerryStop {
  /** Also the `ride` fact's id: a quest names the pad it wants boarded from. */
  id: string;
  /** What the caption and the pad hint call this end. Looked up per call — live language. */
  nameKey: StringKey;
  /** Where the hero stands to ride — the pier, the mooring pad. LOCAL when `frame` is set. */
  x: number;
  z: number;
  /** Ground height at the pad, for the press cylinder's rise band. LOCAL when `frame` is set. */
  y: number;
  /** Where the craft waits, just off the pad. LOCAL when `frame` is set. */
  boatX: number;
  boatZ: number;
  /** The moving piece of world this stop stands on; absent means the ground. */
  frame?: LocalFrame;
}

/** What waits at a stop: a boat floats on one water level, a balloon rests on its pad. */
export type FerryCraft = { kind: "boat"; waterY: number } | { kind: "balloon" };

const NEAR_R = 3.2;
const LEAVE_R = 5.5;
const RISE = 2.5;
const LEAVE_RISE = RISE * 1.5;
const NEAR_R2 = NEAR_R * NEAR_R;
const LEAVE_R2 = LEAVE_R * LEAVE_R;

interface StopState {
  stop: FerryStop;
  craft: THREE.Group;
  /** False until the hero has left the pad once — the landing-pad rule. */
  armed: boolean;
  bob: number;
  /** The pad in WORLD coordinates, refreshed each update for a framed stop. */
  wx: number;
  wy: number;
  wz: number;
  /** The craft's rest yaw in its own frame; a framed stop adds the frame's yaw. */
  yaw: number;
}

const _w = { x: 0, z: 0 };

export class Ferry {
  private readonly scene: THREE.Scene;
  private readonly stops: [StopState, StopState];
  private readonly craftKind: FerryCraft;
  private readonly enabled: () => boolean;
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];
  /** The stop the hero stands in this frame, if any — what a press means. */
  private engaged: StopState | null = null;
  private wasEnabled = false;

  constructor(
    scene: THREE.Scene,
    stops: [FerryStop, FerryStop],
    craft: FerryCraft,
    enabled: () => boolean,
  ) {
    this.scene = scene;
    this.craftKind = craft;
    this.enabled = enabled;
    this.stops = [this.mkStop(stops[0], 0), this.mkStop(stops[1], 1)] as [StopState, StopState];
  }

  private mkStop(stop: FerryStop, i: number): StopState {
    const craft = this.craftKind.kind === "boat" ? this.buildBoat() : this.buildBalloon();
    craft.visible = false;
    this.scene.add(craft);
    const s: StopState = {
      stop,
      craft,
      armed: true,
      bob: i * 1.7,
      wx: stop.x,
      wy: stop.y,
      wz: stop.z,
      yaw: Math.atan2(stop.x - stop.boatX, stop.z - stop.boatZ) + Math.PI / 2,
    };
    this.place(s);
    return s;
  }

  /** Resolve the pad and park the craft, in world coordinates. Cheap: two stops. */
  private place(s: StopState): void {
    const { stop } = s;
    const frame = stop.frame;
    let cx = stop.boatX;
    let cz = stop.boatZ;
    let yaw = s.yaw;
    if (frame) {
      frame.toWorld(stop.x, stop.z, _w);
      s.wx = _w.x;
      s.wz = _w.z;
      s.wy = frame.y + stop.y;
      frame.toWorld(stop.boatX, stop.boatZ, _w);
      cx = _w.x;
      cz = _w.z;
      yaw += frame.yaw;
    }
    const restY = this.craftKind.kind === "boat" ? this.craftKind.waterY : s.wy;
    s.craft.position.set(cx, restY, cz);
    s.craft.rotation.y = yaw;
  }

  private box(
    g: THREE.Group,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    m: THREE.Material,
  ): void {
    const geo = new THREE.BoxGeometry(w, h, d);
    this.geos.push(geo);
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    g.add(mesh);
  }

  /** A rowing boat from five boxes. A placeholder for #228's ships, honestly crude. */
  private buildBoat(): THREE.Group {
    const g = new THREE.Group();
    const hull = new THREE.MeshStandardMaterial({ color: 0x6d4a2f, roughness: 0.9 });
    const trim = new THREE.MeshStandardMaterial({ color: 0x8a6a45, roughness: 0.9 });
    const cloth = new THREE.MeshStandardMaterial({ color: 0xd8d2c0, roughness: 1 });
    this.mats.push(hull, trim, cloth);
    this.box(g, 3.6, 0.7, 1.5, 0, 0.1, 0, hull);
    this.box(g, 3.9, 0.28, 0.36, 0, 0.52, -0.62, trim);
    this.box(g, 3.9, 0.28, 0.36, 0, 0.52, 0.62, trim);
    this.box(g, 0.16, 3.1, 0.16, 0.5, 1.9, 0, trim);
    // A furled sail on the boom, so the boat reads "ready to leave", not wrecked.
    this.box(g, 2.0, 0.3, 0.24, -0.35, 3.1, 0, cloth);
    return g;
  }

  /** Corwin Vane's survey balloon: a basket, four stays and a patched envelope. Placeholder (issue #157). */
  private buildBalloon(): THREE.Group {
    const g = new THREE.Group();
    const wicker = new THREE.MeshStandardMaterial({ color: 0x8a6a45, roughness: 0.95 });
    const rope = new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 1 });
    const cloth = new THREE.MeshStandardMaterial({ color: 0xd9c9a3, roughness: 0.9 });
    const patch = new THREE.MeshStandardMaterial({ color: 0xa8433a, roughness: 0.9 });
    this.mats.push(wicker, rope, cloth, patch);
    this.box(g, 1.6, 1.1, 1.6, 0, 0.55, 0, wicker);
    for (const [sx, sz] of [
      [-0.7, -0.7],
      [0.7, -0.7],
      [-0.7, 0.7],
      [0.7, 0.7],
    ]) {
      this.box(g, 0.08, 3.4, 0.08, sx * 0.9, 2.7, sz * 0.9, rope);
    }
    // Low-poly on purpose: the world is voxels and a smooth sphere would be the odd one out.
    const env = new THREE.SphereGeometry(2.7, 10, 8);
    this.geos.push(env);
    const envelope = new THREE.Mesh(env, cloth);
    envelope.position.set(0, 6.9, 0);
    envelope.scale.set(1, 1.18, 1);
    g.add(envelope);
    // The gore that was patched after Gullspire — a band, so it reads from every side.
    this.box(g, 5.5, 0.9, 0.5, 0, 6.9, 0, patch);
    this.box(g, 0.5, 0.9, 5.5, 0, 6.9, 0, patch);
    return g;
  }

  update(focus: THREE.Vector3, dt: number): void {
    const on = this.enabled();
    if (on !== this.wasEnabled) {
      this.wasEnabled = on;
      for (const s of this.stops) {
        s.craft.visible = on;
      }
    }
    this.engaged = null;
    if (!on) {
      return;
    }
    for (const s of this.stops) {
      s.bob += dt;
      if (s.stop.frame) {
        this.place(s);
      }
      if (this.craftKind.kind === "boat") {
        s.craft.position.y = this.craftKind.waterY + Math.sin(s.bob * 1.1) * 0.06;
        s.craft.rotation.z = Math.sin(s.bob * 0.8) * 0.02;
      } else {
        // Tugging at its stays: a slow lift and lean, never off the pad.
        s.craft.position.y = s.wy + 0.12 + Math.sin(s.bob * 0.7) * 0.12;
        s.craft.rotation.z = Math.sin(s.bob * 0.5) * 0.03;
      }
      const dx = focus.x - s.wx;
      const dz = focus.z - s.wz;
      const dy = focus.y - s.wy;
      const d2 = dx * dx + dz * dz;
      if (d2 > LEAVE_R2 || !inRise(0, dy, LEAVE_RISE)) {
        s.armed = true;
      }
      if (d2 < NEAR_R2 && inRise(0, dy, RISE) && this.engaged === null) {
        this.engaged = s;
      }
    }
  }

  /** The stop the hero stands armed on, or null. The HOST spends the press. */
  atPier(): { from: FerryStop; to: FerryStop } | null {
    const s = this.engaged;
    if (s === null || !s.armed) {
      return null;
    }
    const other = this.stops[0] === s ? this.stops[1] : this.stops[0];
    return { from: s.stop, to: other.stop };
  }

  /** Where a stop's pad is NOW, in world coordinates — a framed stop has moved since the press. */
  landing(stop: FerryStop): { x: number; y: number; z: number } {
    const s = this.stops[0].stop === stop ? this.stops[0] : this.stops[1];
    if (s.stop.frame) {
      this.place(s);
    }
    return { x: s.wx, y: s.wy, z: s.wz };
  }

  /** The ride landed: the pad under the hero must be walked off before it answers again. */
  arrived(at: FerryStop): void {
    for (const s of this.stops) {
      if (s.stop === at) {
        s.armed = false;
      }
    }
  }

  /** Snapshot for `__dbgFerry`. Allocates; never called from the loop. */
  debug(): unknown {
    return {
      enabled: this.wasEnabled,
      engaged: this.engaged?.stop.id ?? null,
      stops: this.stops.map((s) => ({
        id: s.stop.id,
        x: +s.wx.toFixed(2),
        z: +s.wz.toFixed(2),
        y: +s.wy.toFixed(2),
        armed: s.armed,
        boatVisible: s.craft.visible,
      })),
    };
  }

  dispose(): void {
    for (const s of this.stops) {
      this.scene.remove(s.craft);
    }
    for (const g of this.geos) {
      g.dispose();
    }
    for (const m of this.mats) {
      m.dispose();
    }
  }
}
