/**
 * The feedback layer: gameplay events in, rumble and camera shake out.
 *
 * Everything tactile in the game used to be a direct call at the site that
 * caused it — `cam.addShake(0.32)` inside `Player.takeDamage`, a screen flash
 * inside combat — which meant the camera was reachable only from the hero, the
 * combat system could not shake it at all, and adding a second reaction to an
 * existing moment meant editing that moment. Now a moment EMITS and this
 * subscribes.
 *
 * BUFFER AND DRAIN. The bus listener does no work: it digests each event into a
 * `Cue` in a preallocated ring and returns. `drain()` plays the ring once per
 * rendered frame. Three reasons, in order of how much they matter:
 *
 *  1. The haptics API forces it. `playEffect` replaces rather than mixes, so
 *     four hits landing in one frame's four sim slices would issue four effects
 *     each cancelling the last — a blip instead of a hit. Drained, they sum into
 *     one envelope. Per-slice dispatch is not merely noisy for rumble, it is
 *     broken.
 *  2. Coherence. Sim slices run 0..4 times per rendered frame, so an
 *     immediately-dispatched cue lands anywhere in a ~50 ms window relative to
 *     the frame the player actually sees. Draining puts every channel on one
 *     boundary — the one the frame is drawn on.
 *  3. Bounded cost, however many things explode at once.
 *
 * The cost is that shake added at drain is consumed by the NEXT slice's camera
 * update, so it appears up to one frame later. That is not a regression: today
 * `combat.update` already runs after `player.update` in the same slice, so
 * every combat-driven shake was already a slice late, and the hard-landing
 * shake was applied after the camera had been placed too. The drain makes that
 * latency uniform instead of dependent on which slice a hit happened to land
 * in. Removing it entirely means moving shake SAMPLING out of `cam.update`,
 * which also displaces the look target — a real restructure, and a follow-up.
 *
 * NOT here: the red screen flash on taking a hit and the white one on an AoE
 * cast. Both live in combat/vfx.ts next to the effects they belong with, and
 * both are now correctly gated on the hit having landed. Moving them would buy
 * nothing and risk double-flashing.
 */
import type { EventBus, GameEvent } from "../core/types";
import { AudioChannel } from "./audio";
import { CUES, type CueKind } from "./cues";
import { Haptics } from "./haptics";

/**
 * The camera, narrowed to the one thing this needs.
 *
 * Structural rather than importing `ThirdPersonCamera`, so the feedback layer
 * does not grow an import edge into the player package for a single method.
 */
export interface ShakeSink {
  addShake(amount: number): void;
}

export interface FeedbackOptions {
  /**
   * The player's controller-vibration switch, and the master gate in front of
   * every haptic this game issues.
   *
   * It is checked HERE rather than at the cue sites for the same reason the
   * cues are buffered here: this is the one place all of them pass through, so
   * a setting checked once at the drain is a setting that cannot be forgotten
   * by the next thing that emits a hit. It gates the phone's `navigator.vibrate`
   * as well as a pad's motors — `Haptics.pulse` is what routes to either, and
   * nothing reaches it while this is false.
   */
  hapticFeedback: boolean;
  /** 0..1; 0 issues no haptic effect at all. */
  hapticIntensity: number;
  /** 0..1, scaling every cue's tuned shake. */
  shakeIntensity: number;
}

export interface FeedbackDeps extends FeedbackOptions {
  bus: EventBus;
  camera: ShakeSink;
  /** This frame's pad snapshot, or null. Polled, so it must be read live. */
  pad: () => Gamepad | null;
  /**
   * Is the device that last produced input one the player is HOLDING?
   *
   * Polled every frame, like `pad`, because it changes as often as the player
   * changes hands. A predicate rather than the input layer's own enum for the
   * same reason `ShakeSink` is structural: this package does not need to know
   * what a gamepad is, only whether the last thing touched can be felt.
   *
   * The rule it enforces is that rumble belongs to the thing in your hands. A
   * controller left plugged in beside the keyboard sat buzzing through a
   * keyboard player's whole session, because the only question anyone asked was
   * "is a pad connected". A phone keeps buzzing, because there a finger IS the
   * device — see `Haptics.pulse`'s `vibrate` branch.
   *
   * Camera shake is deliberately NOT gated on this. It is something you see,
   * not something you feel, and it belongs to every player on every device.
   */
  tactileInput: () => boolean;
}

/**
 * Ring size. Well past what a frame can legitimately produce — a busy AoE
 * landing on six enemies is six cues — so overflow means something is wrong,
 * and dropping the oldest is the right failure: the newest moments are the ones
 * the player is still looking at.
 */
const RING = 32;

interface Cue {
  kind: CueKind;
  intensity: number;
}

export class FeedbackSystem {
  private ring: Cue[] = Array.from({ length: RING }, () => ({
    kind: "hit" as CueKind,
    intensity: 0,
  }));
  private count = 0;
  private dropped = 0;
  private drained = 0;
  private haptics: Haptics;
  private audio = new AudioChannel();
  private unsubscribe: () => void;
  private lastKind: CueKind | null = null;
  /** Last frame's `tactileInput()`, so the drain can act on the EDGE. */
  private wasTactile = true;

  constructor(private deps: FeedbackDeps) {
    this.haptics = new Haptics(deps.pad);
    this.unsubscribe = deps.bus.on((e) => this.digest(e));
  }

  setOptions(patch: Partial<FeedbackOptions>): void {
    if (patch.hapticFeedback !== undefined && patch.hapticFeedback !== this.deps.hapticFeedback) {
      this.deps.hapticFeedback = patch.hapticFeedback;
      // Turning it off has to silence what is ALREADY ringing, not just stop
      // the next cue: an envelope is up to a second long and `Haptics.update`
      // would keep re-issuing it to the motors after the switch said stop.
      if (!patch.hapticFeedback) {
        this.haptics.stop();
      }
    }
    if (patch.hapticIntensity !== undefined) {
      this.deps.hapticIntensity = patch.hapticIntensity;
    }
    if (patch.shakeIntensity !== undefined) {
      this.deps.shakeIntensity = patch.shakeIntensity;
    }
  }

  /** Note a real user gesture, which is what audio and phone vibration wait for. */
  unlock(): void {
    this.audio.unlock();
  }

  /**
   * Turn an event into a cue. Runs SYNCHRONOUSLY inside `emit`, so it must
   * extract scalars and never retain the event — see the retention rule beside
   * `GameEvent` in core/types.ts.
   */
  private digest(e: GameEvent): void {
    switch (e.type) {
      case "playerHurt":
        this.push("playerHurt", e.amountFrac);
        break;
      case "playerDied":
        this.push("playerDied", 1);
        break;
      case "playerLanded":
        this.push("playerLanded", e.impact);
        break;
      case "hitDealt":
        this.push(e.crit ? "hitCrit" : e.superEffective ? "hitSuper" : "hit", 1);
        break;
      case "enemyKilled":
        this.push("kill", 1);
        break;
      case "mounted":
        this.push("mounted", 1);
        break;
      case "beastLevelUp":
        this.push("levelUp", 1);
        break;
      case "itemPicked":
        this.push("pickup", 1);
        break;
      // The wobble RAMPS: `index` is 1-based and `of` is how many there are, so
      // the last shake before the answer lands at full intensity and the first
      // at a third of it. See `orbWobble` in cues.ts for why this is the only
      // cue outside `playerHurt` that scales.
      case "orbThrown":
        this.push("orbThrow", 1);
        break;
      case "orbWobble":
        this.push("orbWobble", e.of > 0 ? e.index / e.of : 1);
        break;
      case "beastTamed":
        this.push("tameSuccess", 1);
        break;
      case "bondFailed":
        this.push("tameFail", 1);
        break;
      default:
        break;
    }
  }

  private push(kind: CueKind, intensity: number): void {
    if (this.count >= RING) {
      this.dropped++;
      return;
    }
    const c = this.ring[this.count++];
    c.kind = kind;
    c.intensity = Math.min(1, Math.max(0, intensity));
  }

  /** Play everything queued this frame, then advance the rumble mix. */
  drain(dt: number): void {
    const { hapticFeedback, hapticIntensity, shakeIntensity, camera } = this.deps;

    // The second half of the vibration gate, checked in the same place as the
    // first and for the same reason: this is the one point every cue passes
    // through, so a rule applied here cannot be forgotten by the next thing
    // that emits a hit.
    const tactile = this.deps.tactileInput();
    if (tactile !== this.wasTactile) {
      this.wasTactile = tactile;
      // Putting the pad down has to silence what is ALREADY ringing, not just
      // stop the next cue — the identical argument as `setOptions` turning the
      // switch off. An envelope runs up to a second, and `Haptics.update` would
      // keep issuing it to a controller nobody is holding any more.
      if (!tactile) {
        this.haptics.stop();
      }
    }

    for (let i = 0; i < this.count; i++) {
      const { kind, intensity } = this.ring[i];
      const spec = CUES[kind];
      this.lastKind = kind;
      this.drained++;

      if (hapticFeedback && tactile && hapticIntensity > 0) {
        const strong = (spec.strong + spec.strongGain * intensity) * hapticIntensity;
        const weak = spec.weak * hapticIntensity;
        this.haptics.pulse(strong, weak, spec.dur);
      }
      if (spec.shake > 0 && intensity >= spec.shakeMin && shakeIntensity > 0) {
        camera.addShake(spec.shake * shakeIntensity);
      }
      this.audio.play(kind, intensity);
    }
    this.count = 0;
    this.haptics.update(dt);
  }

  debugState(): unknown {
    return {
      drained: this.drained,
      dropped: this.dropped,
      queued: this.count,
      lastKind: this.lastKind,
      hapticFeedback: this.deps.hapticFeedback,
      // Both halves of the rumble gate, so a probe can tell "the player switched
      // it off" apart from "the player is on the keyboard right now".
      tactileInput: this.wasTactile,
      hapticIntensity: this.deps.hapticIntensity,
      shakeIntensity: this.deps.shakeIntensity,
      haptics: this.haptics.debugState(),
      audio: this.audio.debugState(),
    };
  }

  dispose(): void {
    this.unsubscribe();
    this.haptics.stop();
    this.audio.dispose();
    this.count = 0;
  }
}
