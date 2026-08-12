/**
 * Controller rumble: a small mixer over the Gamepad haptics API.
 *
 * A mixer rather than a queue of calls, because `playEffect` REPLACES the
 * running effect instead of layering on it. Fire three effects in one frame —
 * a hit, the crit on the same hit, and a landing — and the driver plays the
 * last one for 25 ms while the other two are cancelled outright. So concurrent
 * cues are summed into ONE envelope here and issued as a single effect.
 *
 * The sum SATURATES rather than taking a maximum. A crit landing while a fall
 * is still ringing out should read heavier than either alone — that is the
 * whole reason for having a mix — and the clamp is what stops it pegging both
 * motors at the first busy moment.
 *
 * Re-issue cadence is the other half of the design and is deliberately NOT
 * per-frame:
 *
 *   - `playEffect` returns a Promise, so every call allocates. At 165 fps that
 *     is 165 promises a second inside an update path, which is exactly what the
 *     no-per-frame-allocation rule exists to prevent.
 *   - Each call also restarts the driver's own ramp. Back-to-back sub-frame
 *     calls make a motor stutter rather than sustain.
 *
 * So it re-issues at 12 Hz with an effect ~2.2x longer than that period (so the
 * running effect never expires before its replacement lands, even on a long
 * frame), and breaks cadence immediately when the mix JUMPS. That last rule is
 * what keeps a fresh hit from arriving up to 83 ms late: steady-state rumble is
 * cheap, onsets are still on the frame they happened.
 */

/** How the rumble is actually delivered, resolved once per pad. */
export type HapticMode = "dual-rumble" | "pulse" | "vibrate" | "none";

/**
 * The Gamepad haptics surface, hand-declared.
 *
 * Written out rather than leaning on lib.dom because the shape has moved: older
 * Chrome exposes `type` where the spec now says `effects`, `hapticActuators` is
 * a different (single-magnitude) interface from `vibrationActuator`, and which
 * of them a given TS lib knows about varies. Every access is optional and every
 * call is guarded, so a browser with none of it lands on `'none'` and the
 * channel goes quiet instead of throwing.
 */
interface RumbleParams {
  duration?: number;
  startDelay?: number;
  strongMagnitude?: number;
  weakMagnitude?: number;
}
interface Actuator {
  type?: string;
  effects?: readonly string[];
  playEffect?(type: string, params: RumbleParams): Promise<string>;
  pulse?(value: number, duration: number): Promise<boolean>;
  reset?(): Promise<string>;
}
type HapticPad = Gamepad & {
  vibrationActuator?: Actuator;
  hapticActuators?: readonly Actuator[];
};

const SLOTS = 6;
/** 12 Hz. See the header for why this is not the frame rate. */
const REISSUE_PERIOD = 1 / 12;
/** Effect length, ~2.2x the period, so there is never a gap between issues. */
const EFFECT_MS = 183;
/** A mix change this big breaks cadence and issues now. */
const JUMP = 0.15;

interface Envelope {
  strong: number;
  weak: number;
  dur: number;
  t: number;
  active: boolean;
}

export class Haptics {
  private env: Envelope[] = Array.from({ length: SLOTS }, () => ({
    strong: 0,
    weak: 0,
    dur: 0,
    t: 0,
    active: false,
  }));
  private modeCache: HapticMode | null = null;
  private modePadId: string | null = null;
  private issueT = 0;
  private lastStrong = 0;
  private lastWeak = 0;
  private issues = 0;

  constructor(private pad: () => Gamepad | null) {}

  /**
   * Resolve how this pad can rumble, once, and re-resolve if the pad changes.
   *
   * The detection ladder is ordered by fidelity: dual-rumble gives independent
   * heavy and light motors, `pulse` collapses to one magnitude, and
   * `navigator.vibrate` is a phone buzzing and cannot sustain a mix at all.
   */
  get mode(): HapticMode {
    const pad = this.pad() as HapticPad | null;
    const id = pad?.id ?? null;
    if (this.modeCache !== null && this.modePadId === id) {
      return this.modeCache;
    }
    this.modePadId = id;
    this.modeCache = resolveMode(pad);
    return this.modeCache;
  }

  get level(): { strong: number; weak: number } {
    return { strong: this.lastStrong, weak: this.lastWeak };
  }

  /** Add a decaying pulse to the mix. Magnitudes 0..1, `dur` in seconds. */
  pulse(strong: number, weak: number, dur: number): void {
    if (dur <= 0 || (strong <= 0 && weak <= 0)) {
      return;
    }

    if (this.mode === "vibrate") {
      // A phone motor has one setting and no envelope, so the mix is
      // meaningless here: cues are delivered as discrete buzzes instead, length
      // scaled by how hard the cue hit. Requires a prior user gesture, and is
      // silently ignored on iOS Safari — both fine, both invisible.
      const ms = Math.round(Math.min(60, Math.max(10, dur * 1000)) * Math.max(strong, weak));
      try {
        navigator.vibrate(ms);
      } catch {
        /* denied or unsupported */
      }
      return;
    }

    const e = this.free();
    if (!e) {
      return;
    } // six concurrent envelopes is already past what is legible
    e.strong = Math.min(1, strong);
    e.weak = Math.min(1, weak);
    e.dur = dur;
    e.t = 0;
    e.active = true;
  }

  update(dt: number): void {
    const mode = this.mode;
    if (mode === "none" || mode === "vibrate") {
      return;
    }

    // Linear decay, not exponential: an exponential leaves a long inaudible
    // tail that keeps the motor spun up and the pad humming after the moment
    // has passed.
    let strong = 0;
    let weak = 0;
    for (const e of this.env) {
      if (!e.active) {
        continue;
      }
      e.t += dt;
      if (e.t >= e.dur) {
        e.active = false;
        continue;
      }
      const k = 1 - e.t / e.dur;
      strong += e.strong * k;
      weak += e.weak * k;
    }
    strong = Math.min(1, strong);
    weak = Math.min(1, weak);

    this.issueT -= dt;

    if (strong <= 0 && weak <= 0) {
      // One explicit zero rather than letting the last effect's 183 ms run out,
      // so the pad stops when the game says it stopped.
      if (this.lastStrong > 0 || this.lastWeak > 0) {
        this.issue(0, 0);
      }
      return;
    }
    const jumped =
      Math.abs(strong - this.lastStrong) > JUMP || Math.abs(weak - this.lastWeak) > JUMP;
    if (jumped || this.issueT <= 0) {
      this.issue(strong, weak);
    }
  }

  /** Silence everything now — a zone change, a dispose, the tab going away. */
  stop(): void {
    for (const e of this.env) {
      e.active = false;
    }
    if (this.mode === "dual-rumble" || this.mode === "pulse") {
      this.issue(0, 0);
    }
  }

  debugState(): unknown {
    return {
      mode: this.mode,
      strong: +this.lastStrong.toFixed(3),
      weak: +this.lastWeak.toFixed(3),
      issues: this.issues,
      active: this.env.filter((e) => e.active).length,
    };
  }

  private free(): Envelope | null {
    for (const e of this.env) {
      if (!e.active) {
        return e;
      }
    }
    return null;
  }

  private issue(strong: number, weak: number): void {
    this.lastStrong = strong;
    this.lastWeak = weak;
    this.issueT = REISSUE_PERIOD;
    this.issues++;
    const pad = this.pad() as HapticPad | null;
    if (!pad) {
      return;
    }
    // Every promise is swallowed. An unsupported effect type REJECTS, and an
    // unhandled rejection thrown once per issue out of the frame loop is a
    // console full of noise that looks like a real fault and is not one.
    if (this.mode === "dual-rumble") {
      pad.vibrationActuator
        ?.playEffect?.("dual-rumble", {
          duration: EFFECT_MS,
          strongMagnitude: strong,
          weakMagnitude: weak,
        })
        .catch(() => {});
    } else if (this.mode === "pulse") {
      // One motor, so the two channels collapse to whichever is asking louder.
      pad.hapticActuators?.[0]?.pulse?.(Math.max(strong, weak), EFFECT_MS).catch(() => {});
    }
  }
}

function resolveMode(pad: HapticPad | null): HapticMode {
  if (pad) {
    const va = pad.vibrationActuator;
    if (va && typeof va.playEffect === "function") {
      // `effects` is the current spelling; `type` is the older Chrome shape.
      // Where neither is present the actuator still very likely does
      // dual-rumble, and a wrong guess costs one caught rejection.
      const named = va.effects?.includes("dual-rumble") ?? va.type === "dual-rumble";
      if (named || (!va.effects && !va.type)) {
        return "dual-rumble";
      }
    }
    if (typeof pad.hapticActuators?.[0]?.pulse === "function") {
      return "pulse";
    }
  }
  // No pad, or a pad with no motors: fall back to the phone, which is the right
  // answer for a touch player and a no-op for everyone else.
  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    return "vibrate";
  }
  return "none";
}
