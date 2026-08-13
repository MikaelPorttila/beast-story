/**
 * Zone lifecycle: one active World, optionally one preloaded, plus the gateway
 * rules. The only caller of `createWorld` / `createDungeon` / `World.dispose`.
 *
 * Gateway numbers are hysteresis pairs against hero speeds (walk 6, sprint
 * 9.6): ENTER_R 3.0 is the arch's own geometry, EXIT_R 5.0 where inside stops
 * (arrival starts DISARMED, or the return fires on frame one), DWELL 1.2 s is
 * longer than any pass-through so you must STOP in the arch.
 */
import type * as THREE from "three";
import { inRise, type World, type WorldBound } from "../core/types";
import { t } from "../i18n";
import { Gateway } from "./portal";

export interface ZoneDef {
  id: string;
  name: string;
  /** Build this zone's World. ZoneManager is the only legal caller. */
  create(scene: THREE.Scene): World;
  /** Called once with the finished world, so the gate can sit on new ground. */
  gate(world: World): { to: string; x: number; z: number; hex: number };
}

const ENTER_R = 3.0;
const EXIT_R = 5.0;
/**
 * Height band above/below the pad, footing to feet. Without it the pad was an
 * infinite column and overflight committed transitions (issue #78). 2.5 is
 * NPC_TALK_RISE: clears a jump apex (1.54) and a hovering mount (2.21), not a
 * climb (4.88).
 */
const GATE_RISE = 2.5;
/** 1.5x, as NPC_LEAVE_RISE: an equal bound disarms on a hover's down-beat. */
const GATE_EXIT_RISE = GATE_RISE * 1.5;
const DWELL = 1.2;
const PRELOAD_R = 30;
const RELEASE_R = 48;

const ENTER_R2 = ENTER_R * ENTER_R;
const EXIT_R2 = EXIT_R * EXIT_R;
const PRELOAD_R2 = PRELOAD_R * PRELOAD_R;
const RELEASE_R2 = RELEASE_R * RELEASE_R;

/**
 * Warm-up steps: step k draws the destination with k pool lights. three keys a
 * program on the light count, so 0..10 (the VFX pool cap) link before arrival.
 */
const WARM_STEPS = 11;
/** Sweep lights live 0.02 s = two 60 Hz slices, so step k needs a stride of 3. */
const WARM_STRIDE = 3;

interface ZoneState {
  def: ZoneDef;
  world: World;
  gateway: Gateway;
  to: string;
  /** Seconds inside ENTER_R. Reset only by leaving EXIT_R. */
  dwell: number;
  /** False until the hero has left EXIT_R at least once. */
  armed: boolean;
  warm: number;
  warmWait: number;
}

export interface ZoneManagerOpts {
  scene: THREE.Scene;
  zones: ZoneDef[];
  start: string;
  /** Subsystems holding the active World; rebound on every switch. */
  bind: WorldBound[];
  /** One warm-up render: camera on `stage`, `lights` pool lights up, draw. */
  warm(stage: THREE.Vector3, lights: number): void;
  /** Arrived; `bind` is already rebound. Gameplay policy goes here. */
  onArrive(world: World, def: ZoneDef, from: ZoneDef | null): void;
  /** Gateway prompt, null to clear. HTML, already localised. */
  onHint?(html: string | null): void;
}

export class ZoneManager {
  transitions = 0;

  private states = new Map<string, ZoneState>();
  private defs = new Map<string, ZoneDef>();
  private activeId: string;
  private pendingId: string | null = null;
  private opts: ZoneManagerOpts;
  private since = 0;
  /** Probe readings: horizontal distance to the gateway, signed rise, verdict. */
  private gateDist = 0;
  private gateRise = 0;
  private gateInside = false;
  /** The zone we just left, handed back a few chunks a frame. */
  private retiring: World | null = null;

  constructor(opts: ZoneManagerOpts) {
    this.opts = opts;
    for (const d of opts.zones) {
      this.defs.set(d.id, d);
    }
    this.activeId = opts.start;
    this.states.set(opts.start, this.build(opts.start));
    // Born here, so armed from the outset — unlike an arrival through a portal.
    this.states.get(opts.start)!.armed = true;
  }

  get world(): World {
    return this.states.get(this.activeId)!.world;
  }
  get id(): string {
    return this.activeId;
  }
  get name(): string {
    return this.states.get(this.activeId)!.def.name;
  }
  get zoneIds(): string[] {
    return [...this.defs.keys()];
  }

  private build(id: string): ZoneState {
    const def = this.defs.get(id);
    if (!def) {
      throw new Error(`unknown zone "${id}"`);
    }
    const world = def.create(this.opts.scene);
    const g = def.gate(world);
    const gateway = new Gateway(this.opts.scene, g.x, world.getHeight(g.x, g.z), g.z, g.hex);
    return { def, world, gateway, to: g.to, dwell: 0, armed: false, warm: 0, warmWait: 0 };
  }

  private destroy(s: ZoneState): void {
    s.gateway.dispose();
    s.world.dispose();
  }

  update(focus: THREE.Vector3, dt: number, newFrame = true): void {
    const active = this.states.get(this.activeId)!;
    this.since += dt;

    // Gated on newFrame: a catch-up frame must not do four frames' deletions.
    if (this.retiring !== null && newFrame && this.retiring.disposeStep()) {
      this.retiring = null;
    }

    active.world.update(focus, dt, newFrame);
    active.gateway.update(dt);

    const gx = focus.x - active.gateway.position.x;
    const gz = focus.z - active.gateway.position.z;
    const gy = focus.y - active.gateway.position.y;
    const d2 = gx * gx + gz * gz;
    this.gateDist = Math.sqrt(d2);
    this.gateRise = gy;
    // A CYLINDER: leaving upward must arm it as walking away does.
    const inside = d2 < ENTER_R2 && inRise(0, gy, GATE_RISE);
    const outside = d2 > EXIT_R2 || !inRise(0, gy, GATE_EXIT_RISE);
    this.gateInside = inside;

    // Preload band, gated on `armed` or arrival rebuilds the zone just left.
    // A SPHERE, not the pad's cylinder: a hero 60 overhead is 60 away.
    const d3 = d2 + gy * gy;
    if (active.armed && d3 < PRELOAD_R2 && this.pendingId === null && active.to !== this.activeId) {
      this.pendingId = active.to;
      const p = this.build(active.to);
      // Hidden: lights are not culled, and two zones lit recompiles this one.
      p.world.setVisible(false);
      p.gateway.group.visible = false;
      this.states.set(active.to, p);
    } else if (d3 > RELEASE_R2 && this.pendingId !== null) {
      const p = this.states.get(this.pendingId)!;
      this.states.delete(this.pendingId);
      this.pendingId = null;
      this.destroy(p);
    }

    let ready = false;
    if (this.pendingId !== null) {
      const p = this.states.get(this.pendingId)!;
      p.world.update(p.world.spawnPoint, dt, newFrame);
      if (newFrame && !p.world.streaming && p.warm < WARM_STEPS) {
        if (p.warmWait > 0) {
          p.warmWait--;
        } else {
          // Hide this zone so the destination compiles against its own lights.
          active.world.setVisible(false);
          active.gateway.group.visible = false;
          p.world.setVisible(true);
          p.gateway.group.visible = true;
          this.opts.warm(p.world.spawnPoint, p.warm);
          p.world.setVisible(false);
          p.gateway.group.visible = false;
          active.world.setVisible(true);
          active.gateway.group.visible = true;
          p.warm++;
          p.warmWait = WARM_STRIDE - 1;
        }
      }
      ready = !p.world.streaming && p.warm >= WARM_STEPS;
    }

    if (outside) {
      active.armed = true;
      active.dwell = 0;
    } else if (active.armed && inside) {
      active.dwell += dt;
    }
    // Between ENTER_R and EXIT_R the dwell HOLDS — neither grows nor resets.

    if (this.opts.onHint) {
      const zone = this.defs.get(active.to)?.name ?? active.to;
      this.opts.onHint(
        !outside && active.armed
          ? active.dwell > 0
            ? t("hint.zoneEntering", {
                zone,
                pct: Math.round((active.dwell / DWELL) * 100),
              })
            : t("hint.zoneStand", { zone })
          : null,
      );
    }

    if (active.dwell >= DWELL && ready) {
      this.commit(active.to);
    }
  }

  /** Swap zones. Everything in `bind` keeps its identity, gains new ground. */
  private commit(to: string): void {
    const prev = this.states.get(this.activeId)!;
    const next = this.states.get(to)!;
    this.activeId = to;
    this.pendingId = null;
    this.since = 0;
    this.transitions++;

    next.world.setVisible(true);
    next.gateway.group.visible = true;

    for (const b of this.opts.bind) {
      b.setWorld(next.world);
    }
    this.opts.onArrive(next.world, next.def, prev.def);

    // You arrive standing on the far gateway; disarmed until you walk out.
    next.armed = false;
    next.dwell = 0;

    // Retired, not destroyed: arch now, chunks a few per frame from update().
    this.states.delete(prev.def.id);
    prev.gateway.dispose();
    prev.world.setVisible(false);
    this.retiring?.dispose();
    this.retiring = prev.world;
    this.opts.onHint?.(null);
  }

  /** Dev console: switch now, building synchronously — a very long frame. */
  switchTo(to: string): string {
    if (to === this.activeId) {
      return `already in ${this.name}`;
    }
    if (!this.defs.has(to)) {
      return `unknown zone "${to}" — ${this.zoneIds.join(", ")}`;
    }
    let s = this.states.get(to);
    if (!s) {
      s = this.build(to);
      this.states.set(to, s);
      this.pendingId = to;
    }
    for (let i = 0; i < 512 && s.world.streaming; i++) {
      s.world.update(s.world.spawnPoint, 0, true);
    }
    const active = this.states.get(this.activeId)!;
    while (s.warm < WARM_STEPS) {
      active.world.setVisible(false);
      s.world.setVisible(true);
      this.opts.warm(s.world.spawnPoint, s.warm);
      s.world.setVisible(false);
      active.world.setVisible(true);
      s.warm++;
    }
    this.commit(to);
    return `entered ${this.name}`;
  }

  /** Snapshot for __dbgZone. Allocates; never called from the loop. */
  debug(): unknown {
    const a = this.states.get(this.activeId)!;
    const p = this.pendingId ? this.states.get(this.pendingId)! : null;
    return {
      id: this.activeId,
      name: a.def.name,
      transitions: this.transitions,
      since: +this.since.toFixed(2),
      chunksLoaded: a.world.chunksLoaded,
      streaming: a.world.streaming,
      resident: [...this.states.keys()],
      gate: {
        to: a.to,
        x: +a.gateway.position.x.toFixed(2),
        y: +a.gateway.position.y.toFixed(2),
        z: +a.gateway.position.z.toFixed(2),
        dist: +this.gateDist.toFixed(2),
        rise: +this.gateRise.toFixed(2),
        dwell: +a.dwell.toFixed(2),
        need: DWELL,
        armed: a.armed,
        // `dist` inside ENTER_R with `inside` false is issue #78's height gate.
        inside: this.gateInside,
      },
      pending: p && {
        id: p.def.id,
        chunksLoaded: p.world.chunksLoaded,
        streaming: p.world.streaming,
        warm: p.warm,
        warmSteps: WARM_STEPS,
        ready: !p.world.streaming && p.warm >= WARM_STEPS,
      },
      retiring: this.retiring !== null,
      radii: {
        enter: ENTER_R,
        exit: EXIT_R,
        rise: GATE_RISE,
        exitRise: GATE_EXIT_RISE,
        dwell: DWELL,
        preload: PRELOAD_R,
        release: RELEASE_R,
      },
    };
  }

  dispose(): void {
    for (const s of this.states.values()) {
      this.destroy(s);
    }
    this.states.clear();
    this.retiring?.dispose();
    this.retiring = null;
  }
}
