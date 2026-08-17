/**
 * Zone lifecycle: one active World, optionally one preloaded, plus the gateway
 * rules. The only caller of `createWorld` / `createDungeon` / `World.dispose`.
 *
 * A GATEWAY TAKES A PRESS, NOT A WAIT. It used to commit on a 1.2 s dwell, and
 * the dwell had a failure mode you cannot argue with: the counter is the ratio
 * of time stood to time needed, but the crossing ALSO waits on the destination
 * being built and warm, so a slow build showed "Entering Embervale… 278%" and a
 * player standing in an arch that never fired. A press cannot run away — it is
 * asked once, and what it waits for it says it is waiting for.
 *
 * Gateway numbers are hysteresis pairs against hero speeds (walk 6, sprint
 * 9.6): ENTER_R 3.0 is the arch's own geometry, EXIT_R 5.0 where inside stops.
 * Arrival starts DISARMED, so a player set down on the far pad has to step out
 * of it before it will take a press — otherwise the way back is one key away
 * from the moment you land, and a mashed key bounces you straight back.
 */
import type * as THREE from "three";
import { inRise, type LocalFrame, type World, type WorldBound } from "../core/types";
import { t } from "../i18n";
import { Gateway } from "./portal";

/**
 * One way out of a zone: where the arch stands and which zone it opens on.
 * With `frame` the arch RIDES a carrier (issue #265): `x/z/y` are frame-local,
 * `y` the deck under the pad, and the pad is re-placed through the frame every
 * slice — the rules stay the same, they are just asked at a moving point.
 */
export interface GateSpec {
  to: string;
  x: number;
  z: number;
  hex: number;
  frame?: LocalFrame;
  y?: number;
}

export interface ZoneDef {
  id: string;
  name: string;
  /** Build this zone's World. ZoneManager is the only legal caller. */
  create(scene: THREE.Scene): World;
  /** Called once with the finished world, so the gates can sit on new ground.
   * A zone may have several ways out (issue #144: the overworld keeps the Hold's
   * arch and gains the coast crossing); each is its own arch with its own rules. */
  gates(world: World): GateSpec[];
  /**
   * A SIDE TRIP: while the player is in THIS zone, the zone its gateway leads
   * back to is rebuilt right after arrival and never distance-released, so the
   * way out is a press rather than a ~7 s rebuild stood in the arch (issue
   * #211 — reported as "the dungeon has no exit"). Costs one resident World
   * for the visit, which is what the preload band spends transiently anyway.
   */
  keepReturn?: boolean;
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
const PRELOAD_R = 30;
const RELEASE_R = 48;

const _gateW = { x: 0, z: 0 };

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

/** Per-arch state: the press rules are about ONE pad, not the zone. */
interface GateState {
  gateway: Gateway;
  to: string;
  /** Set for an arch on a deck; `lx/lz/ly` are its frame-local pad. */
  frame: LocalFrame | null;
  lx: number;
  lz: number;
  ly: number;
  /** Asked for, and waiting on the far side to be built. Cleared by leaving the pad. */
  requested: boolean;
  /** False until the hero has left EXIT_R of THIS pad at least once. */
  armed: boolean;
}

interface ZoneState {
  def: ZoneDef;
  world: World;
  gates: GateState[];
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
  /**
   * The Use key as the HUD spells it — already wrapped in `<kbd>`, and different
   * on a pad. Asked per hint rather than captured, because the device can change
   * mid-session and a captured cap goes stale (the same reason `composeKeyHints`
   * exists in main.ts).
   */
  interactKey?(): string;
}

export class ZoneManager {
  transitions = 0;

  private states = new Map<string, ZoneState>();
  private defs = new Map<string, ZoneDef>();
  private activeId: string;
  private pendingId: string | null = null;
  /** The gate whose band pulled the preload in; the release ring is measured from it. */
  private pendingGate: GateState | null = null;
  private opts: ZoneManagerOpts;
  private since = 0;
  /** Probe readings: horizontal distance to the NEAREST gateway, signed rise, verdict. */
  private gateDist = 0;
  private gateRise = 0;
  private gateInside = false;
  /** The gate the hero is standing in this frame, if any — the one a press means. */
  private engaged: GateState | null = null;
  /** The nearest gate this frame; what the hint and the probe readings describe. */
  private nearGate: GateState | null = null;
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
    for (const g of this.states.get(opts.start)!.gates) {
      g.armed = true;
    }
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
  /**
   * The way OUT of the active zone toward `to`: the direct gate, or — pointing at a
   * zone this one has no arch for — the first gate, which is still the way you leave.
   * `carried` says the pad rides a deck, so `y` is a deck and not the ground.
   */
  gatewayTo(to: string): { x: number; y: number; z: number; to: string; carried: boolean } {
    const state = this.states.get(this.activeId)!;
    const g = state.gates.find((gate) => gate.to === to) ?? state.gates[0];
    const p = g.gateway.position;
    return { x: p.x, y: p.y, z: p.z, to: g.to, carried: g.frame !== null };
  }

  private build(id: string): ZoneState {
    const def = this.defs.get(id);
    if (!def) {
      throw new Error(`unknown zone "${id}"`);
    }
    const world = def.create(this.opts.scene);
    const gates = def.gates(world).map((g): GateState => ({
      gateway: new Gateway(
        this.opts.scene,
        g.x,
        g.frame ? 0 : world.getHeight(g.x, g.z),
        g.z,
        g.hex,
      ),
      to: g.to,
      frame: g.frame ?? null,
      lx: g.x,
      lz: g.z,
      ly: g.y ?? 0,
      requested: false,
      armed: false,
    }));
    const state = { def, world, gates, warm: 0, warmWait: 0 };
    this.placeGates(state);
    return state;
  }

  /** Carried arches follow their decks; a grounded one was placed once, at build. */
  private placeGates(s: ZoneState): void {
    for (const g of s.gates) {
      if (g.frame !== null) {
        g.frame.toWorld(g.lx, g.lz, _gateW);
        g.gateway.moveTo(_gateW.x, g.frame.y + g.ly, _gateW.z, g.frame.yaw);
      }
    }
  }

  private destroy(s: ZoneState): void {
    for (const g of s.gates) {
      g.gateway.dispose();
    }
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
    this.placeGates(active);
    for (const g of active.gates) {
      g.gateway.update(dt);
    }

    // Measure every gate; the press rules are per pad, the readings are the nearest's.
    let near: GateState | null = null;
    let nearD2 = Infinity;
    let nearRise = 0;
    let engaged: GateState | null = null;
    for (const g of active.gates) {
      const gx = focus.x - g.gateway.position.x;
      const gz = focus.z - g.gateway.position.z;
      const gy = focus.y - g.gateway.position.y;
      const d2 = gx * gx + gz * gz;
      // A CYLINDER: leaving upward must arm it as walking away does.
      const inside = d2 < ENTER_R2 && inRise(0, gy, GATE_RISE);
      const outside = d2 > EXIT_R2 || !inRise(0, gy, GATE_EXIT_RISE);
      // WALKING OUT ARMS IT AND TAKES BACK THE ASK: a request is about the arch you
      // are standing in, so leaving cancels it rather than firing behind you.
      if (outside) {
        g.armed = true;
        g.requested = false;
      }
      if (inside && engaged === null) {
        engaged = g;
      }
      if (d2 < nearD2) {
        nearD2 = d2;
        nearRise = gy;
        near = g;
      }
    }
    this.gateDist = Math.sqrt(nearD2);
    this.gateRise = nearRise;
    this.gateInside = engaged !== null;
    this.engaged = engaged;
    this.nearGate = near;

    // Preload band, gated on `armed` or arrival rebuilds the zone just left.
    // A SPHERE, not the pad's cylinder: a hero 60 overhead is 60 away.
    // In a `keepReturn` zone the band is the WHOLE zone: the return world is
    // built as soon as the one just left has finished handing its chunks back,
    // so the wait happens under gameplay instead of under the arch.
    const wantResident = active.def.keepReturn === true && this.retiring === null;
    const d3 = nearD2 + nearRise * nearRise;
    const puller = wantResident
      ? (active.gates[0] ?? null)
      : near !== null && near.armed && d3 < PRELOAD_R2
        ? near
        : null;
    if (puller !== null && this.pendingId === null && puller.to !== this.activeId) {
      this.pendingId = puller.to;
      this.pendingGate = puller;
      const p = this.build(puller.to);
      // Hidden: lights are not culled, and two zones lit recompiles this one.
      p.world.setVisible(false);
      this.setGatesVisible(p, false);
      this.states.set(puller.to, p);
    } else if (this.pendingId !== null && active.def.keepReturn !== true) {
      // Released from the gate that PULLED it — walking to another arch is walking away.
      const pg = this.pendingGate!.gateway.position;
      const px = focus.x - pg.x;
      const pz = focus.z - pg.z;
      const py = focus.y - pg.y;
      if (px * px + pz * pz + py * py > RELEASE_R2) {
        const p = this.states.get(this.pendingId)!;
        this.states.delete(this.pendingId);
        this.pendingId = null;
        this.pendingGate = null;
        this.destroy(p);
      }
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
          this.setGatesVisible(active, false);
          p.world.setVisible(true);
          this.setGatesVisible(p, true);
          this.opts.warm(p.world.spawnPoint, p.warm);
          p.world.setVisible(false);
          this.setGatesVisible(p, false);
          active.world.setVisible(true);
          this.setGatesVisible(active, true);
          p.warm++;
          p.warmWait = WARM_STRIDE - 1;
        }
      }
      ready = !p.world.streaming && p.warm >= WARM_STEPS;
    }

    if (this.opts.onHint) {
      // The hint describes the pad the hero is close to; past EXIT_R there is none.
      const g = near !== null && nearD2 < EXIT_R2 && inRise(0, nearRise, GATE_EXIT_RISE) ? near : null;
      const zone = g ? (this.defs.get(g.to)?.name ?? g.to) : "";
      this.opts.onHint(
        g !== null && g.armed
          ? g.requested
            ? t("hint.zoneEntering", { zone })
            : t("hint.zoneUse", { zone, key: this.opts.interactKey?.() ?? "E" })
          : null,
      );
    }

    // The press is remembered until the far side is ready, so a player who asked
    // once while it was still building is not asked to press again.
    const asked = active.gates.find((g) => g.requested);
    if (asked && ready && this.pendingId === asked.to) {
      this.commit(asked.to);
    }
  }

  private setGatesVisible(s: ZoneState, visible: boolean): void {
    for (const g of s.gates) {
      g.gateway.group.visible = visible;
    }
  }

  /** Swap zones. Everything in `bind` keeps its identity, gains new ground. */
  private commit(to: string): void {
    const prev = this.states.get(this.activeId)!;
    const next = this.states.get(to)!;
    this.activeId = to;
    this.pendingId = null;
    this.pendingGate = null;
    // Stale pointers into the zone just left; a press before the next update means nothing.
    this.engaged = null;
    this.nearGate = null;
    this.since = 0;
    this.transitions++;

    next.world.setVisible(true);
    this.setGatesVisible(next, true);
    // Its decks may have moved since it was built; `onArrive` may land the hero on one.
    this.placeGates(next);

    for (const b of this.opts.bind) {
      b.setWorld(next.world);
    }
    this.opts.onArrive(next.world, next.def, prev.def);

    // You may arrive standing on a gateway; every pad is disarmed until walked out
    // of, and the ones you are NOT standing on arm on the first update.
    for (const g of next.gates) {
      g.armed = false;
      g.requested = false;
    }

    // Retired, not destroyed: arch now, chunks a few per frame from update().
    this.states.delete(prev.def.id);
    for (const g of prev.gates) {
      g.gateway.dispose();
    }
    prev.world.setVisible(false);
    this.retiring?.dispose();
    this.retiring = prev.world;
    this.opts.onHint?.(null);
  }

  /**
   * THE PLAYER ASKED TO CROSS. Refused unless he is standing in an ARMED arch,
   * so a press meant for something else cannot move him and a press on the pad
   * he just landed on does nothing until he steps off it.
   *
   * Returns whether the press was SPENT, because the host's Use key has other
   * readers and two of them must not both answer it.
   */
  requestCrossing(): boolean {
    const g = this.engaged;
    if (g === null || !g.armed || g.requested) {
      return false;
    }
    g.requested = true;
    return true;
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
    // `gate` stays the probe's one-arch view — the NEAREST — beside the full list.
    const n = this.nearGate ?? a.gates[0];
    return {
      id: this.activeId,
      name: a.def.name,
      transitions: this.transitions,
      since: +this.since.toFixed(2),
      chunksLoaded: a.world.chunksLoaded,
      streaming: a.world.streaming,
      resident: [...this.states.keys()],
      gate: {
        to: n.to,
        x: +n.gateway.position.x.toFixed(2),
        y: +n.gateway.position.y.toFixed(2),
        z: +n.gateway.position.z.toFixed(2),
        dist: +this.gateDist.toFixed(2),
        rise: +this.gateRise.toFixed(2),
        requested: n.requested,
        armed: n.armed,
        // `dist` inside ENTER_R with `inside` false is issue #78's height gate.
        inside: this.gateInside,
      },
      gates: a.gates.map((g) => ({
        to: g.to,
        x: +g.gateway.position.x.toFixed(2),
        y: +g.gateway.position.y.toFixed(2),
        z: +g.gateway.position.z.toFixed(2),
        carried: g.frame !== null,
        requested: g.requested,
        armed: g.armed,
      })),
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
