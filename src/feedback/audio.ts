/**
 * The sound channel — A SEAM, NOT AN IMPLEMENTATION.
 *
 * There is no audio in Beast Story: no `AudioContext`, no assets, no dependency
 * (three is the only runtime one), no volume control. This file exists so that
 * the day sound is written it plugs into a feedback layer that is already
 * timed, already mixed with the rumble, already drained on the right frame, and
 * already carries an intensity per cue — rather than being retrofitted through
 * a dozen call sites in combat and player code.
 *
 * `play()` is a counted no-op. The count is not decoration: it is what lets
 * tools/test-gamepad.mjs assert the seam is wired and firing on the right beats
 * before there is anything to hear.
 *
 * WHEN SOUND ARRIVES, it goes behind `unlock()`. A browser will not let a page
 * make noise until the user has interacted with it, and a page load is not an
 * interaction — the same rule that forces `navigator.vibrate` to wait, and the
 * same one ui/fullscreen.ts documents at length for the fullscreen request.
 * So the `AudioContext` must be constructed inside `unlock()`, called from a
 * real gesture (a click, a key, a first pad press), and never from module load
 * or from a constructor. Building it eagerly gets a context stuck in
 * `suspended` that never recovers on some browsers, which presents as "audio
 * works on my machine and is silent on yours".
 *
 * Consistent with the rest of the codebase, whatever lands here should be
 * GENERATED — oscillators and noise bursts shaped in code, like every model,
 * animation and effect in this project — not sample files.
 */
import type { CueKind } from "./cues";

export class AudioChannel {
  private unlockedFlag = false;
  private calls = 0;
  private lastCue: CueKind | null = null;

  get unlocked(): boolean {
    return this.unlockedFlag;
  }

  /**
   * Note that a real user gesture has happened, so audio may start.
   *
   * Idempotent and currently only bookkeeping — the `AudioContext` belongs on
   * this line when there is one.
   */
  unlock(): void {
    this.unlockedFlag = true;
  }

  /** Play a cue at 0..1 intensity. Silent today; see the header. */
  play(cue: CueKind, _intensity: number): void {
    this.calls++;
    this.lastCue = cue;
  }

  debugState(): unknown {
    return { unlocked: this.unlockedFlag, calls: this.calls, lastCue: this.lastCue };
  }

  dispose(): void {
    this.unlockedFlag = false;
  }
}
