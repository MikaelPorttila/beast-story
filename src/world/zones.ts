/**
 * Zone loading: which `World` is under your feet, and how you get from one to
 * another without losing anything.
 *
 * The `World` contract was already a zone interface — height/climb/trunk
 * queries, a streaming `update`, a spawn point, a `dispose` — so this module
 * adds no new abstraction over it. What it adds is the LIFECYCLE that was
 * missing: exactly one active world, optionally one more being built ahead of
 * time, the rebinding of every subsystem that captured a world at construction,
 * and the rules that decide when a gateway means anything.
 *
 * ZoneManager is the only thing in the game that calls `createWorld` /
 * `createDungeon` or `World.dispose()`.
 *
 * ---------------------------------------------------------------------------
 * THE THREE NUMBERS
 * ---------------------------------------------------------------------------
 * A gateway is not a threshold. One radius with a transition on the far side of
 * it is what makes doorways in games flicker: stand on the line, breathe, and
 * you cross twice. So there are three separate numbers, each answering a
 * different question, and all three are tuned against the hero's own speeds
 * (WALK_SPEED 6, sprint 9.6 units/s — see player/index.ts).
 *
 *   ENTER_R 3.0   Where the pad is. The gateway's lit ring is 2.45 units across
 *                 and its pillars stand at 2.3, so 3.0 is "inside the arch"
 *                 measured on the geometry, not a number picked to feel right.
 *
 *   EXIT_R 5.0    Where being inside STOPS. Strictly larger than ENTER_R, and
 *                 the 2.0-unit gap is the hysteresis: to undo any progress you
 *                 have to walk 2 metres of real ground (0.33 s at walk speed),
 *                 which no amount of jitter, knockback or camera-relative
 *                 strafing produces. It is the same idea, and roughly the same
 *                 proportion, as the chunk streamer's VIEW_RADIUS 5 /
 *                 UNLOAD_RADIUS 6.5 pair. EXIT_R has a second job: on arrival
 *                 the hero is standing ON the destination's gateway, so that
 *                 gateway starts DISARMED and only arms once he has left EXIT_R
 *                 — otherwise the return trip fires on the first frame and you
 *                 ping-pong forever.
 *
 *   DWELL 1.2 s   How long "inside" has to last before it commits. The longest
 *                 possible straight line through the enter disc is its diameter,
 *                 6.0 units, and at WALK_SPEED that takes 1.0 s — so 1.2 s is
 *                 chosen to be strictly longer than ANY pass-through at any
 *                 speed the hero has. Walking over the gateway, twice, ten
 *                 times, cannot trigger it; you have to stop in the arch. That
 *                 is the whole property, and it is why the number is 1.2 and not
 *                 something rounder.
 *
 * Plus the band that makes the transition free rather than merely correct:
 *
 *   PRELOAD_R 30  Start BUILDING the destination when the player comes within
 *                 30 units of the gateway. From there to the pad is 27 units:
 *                 4.5 s at walk speed, 2.8 s sprinting. Measured on an RTX
 *                 3070 Ti, the Sunken Hold's 24 chunks and its whole warm-up
 *                 sweep are finished 0.72 s after the band opens — comfortably
 *                 inside even the sprint case, so by the time the dwell timer
 *                 has anything to say the destination is built and warmed and
 *                 the switch itself is a pointer swap.
 *
 *   RELEASE_R 48  And unload it again if he wanders off. 1.6x PRELOAD_R, for
 *                 the same reason ENTER/EXIT differ: pacing around the 30-unit
 *                 rim must not build and destroy a zone on alternate frames.
 *                 Verified by oscillating 28 <-> 34 eight times: the pending
 *                 zone stayed built and warmed throughout.
 *
 * And the fourth number, which is a HEIGHT rather than a radius: see GATE_RISE.
 */
import * as THREE from 'three';
import { inRise, type World, type WorldBound } from '../core/types';
import { t } from '../i18n';
import { Gateway } from './portal';

export interface ZoneDef {
  id: string;
  name: string;
  /** Build this zone's World. ZoneManager is the only legal caller. */
  create(scene: THREE.Scene): World;
  /**
   * Where this zone's gateway stands and where it leads. Called once, with the
   * finished world, so a zone can put its gateway on ground it just generated.
   */
  gate(world: World): { to: string; x: number; z: number; hex: number };
}

const ENTER_R = 3.0;
const EXIT_R = 5.0;
/**
 * How far ABOVE OR BELOW the pad you may be and still be in the arch, in world
 * units between the gateway's footing and the hero's feet.
 *
 * Issue #78: there was no such number. The pad was an infinite column, so a hero
 * crossing the map on a galebird was "standing in the arch" every time his
 * shadow passed over it — the prompt came up, the dwell counted, and 1.2 s of
 * level flight committed a zone transition he never asked for.
 *
 * 2.5 is NPC_TALK_RISE (world/npc.ts), and deliberately the same number for the
 * same reasons — it is the same question about the same hero. Both bounds it has
 * to clear were measured there: a jump apex is dy 1.54 and a flying mount at
 * rest hovers at 2.21, so a hop must not blink the prompt and you must still be
 * able to ride through a portal, while half a second of climb is dy 4.88 and is
 * out. Anything reached by CLIMBING leaves the pad on the first frame.
 */
const GATE_RISE = 2.5;
/**
 * And where being in the arch stops, vertically. EXIT_R is to ENTER_R what this
 * is to GATE_RISE, and the 1.5x is NPC_LEAVE_RISE's: a mount BOBS on its hover
 * where a walker does not, so a leave bound equal to the entry bound would
 * disarm the pad on the down-beat.
 */
const GATE_EXIT_RISE = GATE_RISE * 1.5;
const DWELL = 1.2;
const PRELOAD_R = 30;
const RELEASE_R = 48;

const ENTER_R2 = ENTER_R * ENTER_R;
const EXIT_R2 = EXIT_R * EXIT_R;
const PRELOAD_R2 = PRELOAD_R * PRELOAD_R;
const RELEASE_R2 = RELEASE_R * RELEASE_R;

/**
 * Warm-up sweep, in steps. Step k draws the destination with k pool lights up.
 *
 * The count matters as much as the drawing: three keys a shader program on the
 * NUMBER OF VISIBLE LIGHTS, so a brand-new material needs one program per count
 * it will ever see, and a firefight that lights three projectiles at once inside
 * a freshly entered zone would otherwise link them one burst at a time. 11 steps
 * covers 0 (the common case — no effects on screen) through the VFX pool's cap
 * of 10. See warmUpShaders() in main.ts for the measurements that made this
 * necessary at boot; a new zone's materials are the same problem again.
 *
 * What the sweep is worth, measured on an RTX 3070 Ti with __dbgProgKeys()
 * snapshotted either side of a transition:
 *
 *   before any of this   25 programs linked in the seconds AFTER arrival, one
 *                        burst of them costing a 157 ms frame and a 311 ms one
 *   with the sweep       0 linked after arrival; the whole bill moves into the
 *                        approach, where it is 1 program and one 77 ms frame
 *                        as the preload band opens
 *
 * Most of that improvement is NOT the sweep itself but what the sweep made
 * visible: a destination whose materials use define sets the game has already
 * compiled needs no new programs at all. The sweep is what proves it, and what
 * pays the bill up front for the zone that inevitably breaks the rule.
 */
const WARM_STEPS = 11;
/**
 * Frames between sweep steps. The pool lights the sweep raises are `flashLight`
 * slots with a 0.02 s life, so they need two 60 Hz simulation slices to expire;
 * stepping every third frame guarantees step k renders with exactly k lights and
 * not with k plus whatever the previous step left burning. 11 steps x 3 = 33
 * frames, about 0.55 s, and one extra scene render on a third of them.
 *
 * A WIDER STRIDE DOES NOT BUY ANYTHING, and it was worth measuring: the cost of
 * a step that has programs to link is the LINK, and three forces it inside the
 * draw call (it reads the program's uniforms, which blocks on LINK_STATUS).
 * Swept at 3 and at 14 frames, the per-step cost was identical to within noise.
 * The lever that works is having nothing to link — see the note on program keys
 * in world/dungeon.ts.
 */
const WARM_STRIDE = 3;

interface ZoneState {
  def: ZoneDef;
  world: World;
  gateway: Gateway;
  to: string;
  /** Seconds accumulated inside ENTER_R. Reset only by leaving EXIT_R. */
  dwell: number;
  /** False until the hero has left EXIT_R at least once. See EXIT_R above. */
  armed: boolean;
  /** Warm-up sweep progress, 0..WARM_STEPS. */
  warm: number;
  warmWait: number;
}

export interface ZoneManagerOpts {
  scene: THREE.Scene;
  zones: ZoneDef[];
  start: string;
  /** Subsystems holding the active World; rebound on every switch. */
  bind: WorldBound[];
  /**
   * One warm-up render: park the camera on `stage`, make `lights` pool lights
   * visible, draw, put the camera back. Implemented in main.ts, which is the
   * only place that owns both the engine and the combat system.
   */
  warm(stage: THREE.Vector3, lights: number): void;
  /**
   * The hero has arrived in `world`. Everything in `bind` is already rebound;
   * this is where gameplay policy (teleport, dismount, toast) happens.
   */
  onArrive(world: World, def: ZoneDef, from: ZoneDef | null): void;
  /**
   * Player-facing prompt while near a gateway; null clears it.
   *
   * HTML, and already localised — it comes out of the string table whole. The
   * HUD's hint pill writes it as innerHTML (see HUD.showHint).
   */
  onHint?(html: string | null): void;
}

export class ZoneManager {
  /** Completed transitions this session. The anti-thrash tests watch this. */
  transitions = 0;

  private states = new Map<string, ZoneState>();
  private defs = new Map<string, ZoneDef>();
  private activeId: string;
  private pendingId: string | null = null;
  private opts: ZoneManagerOpts;
  /** Seconds since the last arrival, for the probe. */
  private since = 0;
  /** Last measured HORIZONTAL distance to the active gateway, for the probe. */
  private gateDist = 0;
  /** And the signed height above its footing — the other half of the pad test. */
  private gateRise = 0;
  /** Whether both halves said yes this frame. */
  private gateInside = false;
  /** The zone we just left, being handed back a few chunks a frame. */
  private retiring: World | null = null;

  constructor(opts: ZoneManagerOpts) {
    this.opts = opts;
    for (const d of opts.zones) this.defs.set(d.id, d);
    this.activeId = opts.start;
    this.states.set(opts.start, this.build(opts.start));
    // The starting zone is entered by being born in it, so its gateway is armed
    // from the outset — unlike one you arrive at through a portal.
    this.states.get(opts.start)!.armed = true;
  }

  get world(): World { return this.states.get(this.activeId)!.world; }
  get id(): string { return this.activeId; }
  get name(): string { return this.states.get(this.activeId)!.def.name; }
  get zoneIds(): string[] { return [...this.defs.keys()]; }

  private build(id: string): ZoneState {
    const def = this.defs.get(id);
    if (!def) throw new Error(`unknown zone "${id}"`);
    const world = def.create(this.opts.scene);
    const g = def.gate(world);
    const gateway = new Gateway(this.opts.scene, g.x, world.getHeight(g.x, g.z), g.z, g.hex);
    return { def, world, gateway, to: g.to, dwell: 0, armed: false, warm: 0, warmWait: 0 };
  }

  private destroy(s: ZoneState): void {
    s.gateway.dispose();
    s.world.dispose();
  }

  /**
   * Stream the active zone, run the gateway rules, and drive whatever is being
   * preloaded. Replaces the bare `world.update()` call in the frame loop.
   */
  update(focus: THREE.Vector3, dt: number, newFrame = true): void {
    const active = this.states.get(this.activeId)!;
    this.since += dt;

    // Hand back the previous zone's buffers a few per frame. Gated on newFrame
    // for the same reason the chunk build budget is: a catch-up frame that runs
    // four simulation slices must not do four frames' worth of deletions.
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
    // The pad is a CYLINDER, and "outside" is the hysteresis twin of "inside" in
    // BOTH axes — leaving upward has to arm the gateway exactly as walking away
    // does, or a hero who arrives, takes off and comes back down on the same pad
    // is stuck with a gateway that can never fire again. See GATE_RISE.
    const inside = d2 < ENTER_R2 && inRise(0, gy, GATE_RISE);
    const outside = d2 > EXIT_R2 || !inRise(0, gy, GATE_EXIT_RISE);
    this.gateInside = inside;

    // ---- preload band -----------------------------------------------------
    // Gated on `armed`, which is what stops the zone you just left from being
    // rebuilt the instant you arrive: you land ON the return gateway, so
    // distance alone says "approaching" when the truth is "standing on the
    // doormat". Measured without this, walking into the hold disposed ~90
    // overworld chunks and immediately started rebuilding all of them.
    // A SPHERE here, not the pad's cylinder: this band is "how far is the player
    // from that arch", and the answer for a hero 60 units overhead is 60 — there
    // is no reason to spend a zone build on him. Approaching along the ground is
    // unaffected, gy being ~0 on the walk in.
    const d3 = d2 + gy * gy;
    if (active.armed && d3 < PRELOAD_R2 && this.pendingId === null && active.to !== this.activeId) {
      this.pendingId = active.to;
      const p = this.build(active.to);
      // A zone being built ahead of time is HIDDEN. It is 8192 units away and
      // frustum-culled anyway, so this costs nothing to draw — but its LIGHTS
      // are not culled, and two zones' lamps lit at once would change the
      // scene's light count and make the zone you are standing in recompile.
      // It is shown for the duration of each warm-up render and no longer.
      p.world.setVisible(false);
      p.gateway.group.visible = false;
      this.states.set(active.to, p);
    } else if (d3 > RELEASE_R2 && this.pendingId !== null) {
      const p = this.states.get(this.pendingId)!;
      this.states.delete(this.pendingId);
      this.pendingId = null;
      this.destroy(p);
    }

    // ---- the pending zone builds and warms itself -------------------------
    let ready = false;
    if (this.pendingId !== null) {
      const p = this.states.get(this.pendingId)!;
      // Focus on its own spawn: nobody is standing in it yet, and that is the
      // patch of it the hero is about to be standing on.
      p.world.update(p.world.spawnPoint, dt, newFrame);
      if (newFrame && !p.world.streaming && p.warm < WARM_STEPS) {
        if (p.warmWait > 0) {
          p.warmWait--;
        } else {
          // Stand the zone we are IN down for the duration of the warm render,
          // so the destination is compiled against its own light population and
          // not against ours. See World.setVisible — with the overworld's four
          // den lamps still lit, every count came out four too high and the
          // dungeon linked 25 programs on arrival instead of none.
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

    // ---- arm / dwell / commit ---------------------------------------------
    if (outside) {
      active.armed = true;
      active.dwell = 0;
    } else if (active.armed && inside) {
      active.dwell += dt;
    }
    // Between ENTER_R and EXIT_R the dwell HOLDS: it neither grows nor resets.
    // That band is what a hero shuffling on the rim of the pad lives in, and
    // either treatment of it would be wrong — growing lets you trigger from
    // outside the arch, resetting makes the last centimetre of the approach
    // undo the whole wait.

    if (this.opts.onHint) {
      // ONE table entry per state with the destination and the percentage as
      // placeholders. This used to be four fragments glued around the values,
      // which pins the word order to English — a language that says "into
      // {zone} you are walking" has nowhere to stand in a concatenation. The
      // zone's `name` is itself already a table lookup (see ZoneDef in main.ts);
      // `active.to` is the ID and only ever appears if a def is missing, which
      // is a bug rather than a string.
      const zone = this.defs.get(active.to)?.name ?? active.to;
      this.opts.onHint(
        !outside && active.armed
          ? active.dwell > 0
            ? t('hint.zoneEntering', {
              zone, pct: Math.round((active.dwell / DWELL) * 100),
            })
            : t('hint.zoneStand', { zone })
          : null,
      );
    }

    if (active.dwell >= DWELL && ready) this.commit(active.to);
  }

  /**
   * Swap zones. Everything in `bind` keeps its identity — its hp, its level, its
   * inventory — and is simply handed the new ground.
   */
  private commit(to: string): void {
    const prev = this.states.get(this.activeId)!;
    const next = this.states.get(to)!;
    this.activeId = to;
    this.pendingId = null;
    this.since = 0;
    this.transitions++;

    // It was hidden while it was only being prepared; now it is the world.
    next.world.setVisible(true);
    next.gateway.group.visible = true;

    for (const b of this.opts.bind) b.setWorld(next.world);
    this.opts.onArrive(next.world, next.def, prev.def);

    // You arrive standing on the far gateway. Disarmed, so it cannot fire until
    // you have walked out of its exit radius — this is the half of the
    // hysteresis that stops a transition from immediately undoing itself.
    next.armed = false;
    next.dwell = 0;

    // The zone we left is RETIRED, not destroyed: its arch goes now (one small
    // group) and its chunks go a few per frame from update(). See
    // World.disposeStep. A transition arriving while one is still retiring is
    // not a case worth spreading — finish the old one first, or it leaks.
    this.states.delete(prev.def.id);
    prev.gateway.dispose();
    prev.world.setVisible(false);
    this.retiring?.dispose();
    this.retiring = prev.world;
    this.opts.onHint?.(null);
  }

  /**
   * Force a switch now, for the dev console. Builds and warms the destination
   * synchronously if it is not already resident — which is a long frame, and is
   * exactly the frame the preload band exists to avoid in normal play.
   */
  switchTo(to: string): string {
    if (to === this.activeId) return `already in ${this.name}`;
    if (!this.defs.has(to)) return `unknown zone "${to}" — ${this.zoneIds.join(', ')}`;
    let s = this.states.get(to);
    if (!s) {
      s = this.build(to);
      this.states.set(to, s);
      this.pendingId = to;
    }
    // Drain the queue. Bounded: the loop cannot outlive the finite chunk list.
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

  /** Read-only snapshot for __dbgZone. Allocates; never called from the loop. */
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
        // Both halves, as the frame actually decided them — a `dist` inside
        // ENTER_R with `inside` false is issue #78's case, and reading it off
        // the two numbers is the only way a probe can tell the height gate
        // apart from a hero who simply is not there.
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
        enter: ENTER_R, exit: EXIT_R, rise: GATE_RISE, exitRise: GATE_EXIT_RISE,
        dwell: DWELL, preload: PRELOAD_R, release: RELEASE_R,
      },
    };
  }

  dispose(): void {
    for (const s of this.states.values()) this.destroy(s);
    this.states.clear();
    this.retiring?.dispose();
    this.retiring = null;
  }
}
