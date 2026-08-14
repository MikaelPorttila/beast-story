/**
 * THE FERRY: a scripted sail between two piers of the SAME world. Act 2 is part
 * of the open world (issue #144) — there is no zone and no instance behind this,
 * only a crossing the hero cannot yet make himself. `sea-revealed` moors the
 * boats; the water mount later makes them optional.
 *
 * The press rules are the Gateway's, deliberately: standing on the pier is not
 * sailing, the PRESS is the ask, and the pad you LAND on is disarmed until you
 * walk off it — or the same key that brought you bounces you straight back.
 * The numbers quote the gateway pair (ENTER_R/EXIT_R, GATE_RISE) for the same
 * hysteresis reasons; see zones.ts.
 *
 * The boat models are placeholders — issue #228 builds the real harbour kit
 * (quays, deck bridges, ships); these exist so a moored boat MARKS the crossing.
 */
import * as THREE from "three";
import { inRise } from "../core/types";

export interface FerryStop {
  id: string;
  /** Where the hero stands to sail — the pier. */
  x: number;
  z: number;
  /** Ground height at the pier, for the press cylinder's rise band. */
  y: number;
  /** Where the boat floats, just off the pier on the water side. */
  boatX: number;
  boatZ: number;
}

const NEAR_R = 3.2;
const LEAVE_R = 5.5;
const RISE = 2.5;
const LEAVE_RISE = RISE * 1.5;
const NEAR_R2 = NEAR_R * NEAR_R;
const LEAVE_R2 = LEAVE_R * LEAVE_R;

interface StopState {
  stop: FerryStop;
  boat: THREE.Group;
  /** False until the hero has left the pad once — the landing-pad rule. */
  armed: boolean;
  bob: number;
}

export class Ferry {
  private readonly scene: THREE.Scene;
  private readonly stops: [StopState, StopState];
  private readonly waterY: number;
  private readonly enabled: () => boolean;
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];
  /** The stop the hero stands in this frame, if any — what a press means. */
  private engaged: StopState | null = null;
  private wasEnabled = false;

  constructor(
    scene: THREE.Scene,
    stops: [FerryStop, FerryStop],
    waterY: number,
    enabled: () => boolean,
  ) {
    this.scene = scene;
    this.waterY = waterY;
    this.enabled = enabled;
    this.stops = [this.mkStop(stops[0], 0), this.mkStop(stops[1], 1)] as [StopState, StopState];
  }

  private mkStop(stop: FerryStop, i: number): StopState {
    const boat = this.buildBoat();
    boat.position.set(stop.boatX, this.waterY, stop.boatZ);
    boat.rotation.y = Math.atan2(stop.x - stop.boatX, stop.z - stop.boatZ) + Math.PI / 2;
    boat.visible = false;
    this.scene.add(boat);
    return { stop, boat, armed: true, bob: i * 1.7 };
  }

  /** A rowing boat from five boxes. A placeholder for #228's ships, honestly crude. */
  private buildBoat(): THREE.Group {
    const g = new THREE.Group();
    const hull = new THREE.MeshStandardMaterial({ color: 0x6d4a2f, roughness: 0.9 });
    const trim = new THREE.MeshStandardMaterial({ color: 0x8a6a45, roughness: 0.9 });
    const cloth = new THREE.MeshStandardMaterial({ color: 0xd8d2c0, roughness: 1 });
    this.mats.push(hull, trim, cloth);
    const add = (w: number, h: number, d: number, x: number, y: number, z: number, m: THREE.Material) => {
      const geo = new THREE.BoxGeometry(w, h, d);
      this.geos.push(geo);
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, z);
      g.add(mesh);
    };
    add(3.6, 0.7, 1.5, 0, 0.1, 0, hull);
    add(3.9, 0.28, 0.36, 0, 0.52, -0.62, trim);
    add(3.9, 0.28, 0.36, 0, 0.52, 0.62, trim);
    add(0.16, 3.1, 0.16, 0.5, 1.9, 0, trim);
    // A furled sail on the boom, so the boat reads "ready to leave", not wrecked.
    add(2.0, 0.3, 0.24, -0.35, 3.1, 0, cloth);
    return g;
  }

  update(focus: THREE.Vector3, dt: number): void {
    const on = this.enabled();
    if (on !== this.wasEnabled) {
      this.wasEnabled = on;
      for (const s of this.stops) {
        s.boat.visible = on;
      }
    }
    this.engaged = null;
    if (!on) {
      return;
    }
    for (const s of this.stops) {
      s.bob += dt;
      s.boat.position.y = this.waterY + Math.sin(s.bob * 1.1) * 0.06;
      s.boat.rotation.z = Math.sin(s.bob * 0.8) * 0.02;
      const dx = focus.x - s.stop.x;
      const dz = focus.z - s.stop.z;
      const dy = focus.y - s.stop.y;
      const d2 = dx * dx + dz * dz;
      if (d2 > LEAVE_R2 || !inRise(0, dy, LEAVE_RISE)) {
        s.armed = true;
      }
      if (d2 < NEAR_R2 && inRise(0, dy, RISE) && this.engaged === null) {
        this.engaged = s;
      }
    }
  }

  /** The pier the hero stands armed on, or null. The HOST spends the press. */
  atPier(): { from: FerryStop; to: FerryStop } | null {
    const s = this.engaged;
    if (s === null || !s.armed) {
      return null;
    }
    const other = this.stops[0] === s ? this.stops[1] : this.stops[0];
    return { from: s.stop, to: other.stop };
  }

  /** The sail landed: the pad under the hero must be walked off before it answers again. */
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
        x: +s.stop.x.toFixed(2),
        z: +s.stop.z.toFixed(2),
        y: +s.stop.y.toFixed(2),
        armed: s.armed,
        boatVisible: s.boat.visible,
      })),
    };
  }

  dispose(): void {
    for (const s of this.stops) {
      this.scene.remove(s.boat);
    }
    for (const g of this.geos) {
      g.dispose();
    }
    for (const m of this.mats) {
      m.dispose();
    }
  }
}
