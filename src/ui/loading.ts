import { t, onLanguageChange, type StringKey } from '../i18n';
import { injectStyles } from './styles';

/**
 * The boot progress indicator: a corner chip while the title screen is up, and
 * the full loading screen the game is handed over behind.
 *
 * WHY THERE IS ONE AT ALL
 *
 * The game used to be BUILT BEFORE THE POSTER COULD PAINT. Measured on the dev
 * server at 1280x800 with a long-task observer installed ahead of the app
 * module: ONE unbroken 14702 ms task starting at 140 ms, and first contentful
 * paint at 15312 ms. Nothing was on screen — not the menu, not the canvas, not a
 * spinner — for fifteen seconds, because `createWorld`, ten beast rigs and the
 * whole shader warm-up all ran to completion inside the module body before the
 * browser was ever let go of. The same load now has the title screen up at
 * 221 ms and the rest of that work reported behind it.
 *
 * So the module body now YIELDS between its phases, and the price of yielding
 * is that somebody has to say what is happening in the gap. That is this file.
 *
 * TWO FACES, ONE ELEMENT
 *
 *   chip   Bottom-right, small, translucent, ABOVE the poster (z 55). What the
 *          player sees while they are reading the title screen: the world is
 *          being built behind it and the chip is the only admission of that.
 *   cover  Full screen, opaque, BELOW the poster (z 45). Raised the moment New
 *          Game is pressed, so the menu's own half-second dissolve reveals the
 *          loading screen rather than a half-built world; it is then faded out
 *          itself once there is a game to show.
 *
 * The z-index inversion between the two is the whole trick and it is worth
 * stating plainly: the chip has to be seen OVER the poster, and the cover has
 * to be discovered UNDER it. One element, one class swap, and the menu's
 * existing fade does the transition for free.
 *
 * THE BAR IS NOT DECORATIVE. Every number on it is a real fraction of real
 * work — see `STAGES` — and the two long stages report sub-progress as they
 * go. Nothing here animates on a timer, and there is no minimum dwell: a boot
 * that finishes in 400 ms shows 400 ms of loading screen.
 */

/** The phases of a cold boot, in the order main.ts runs them. */
export type LoadStage = 'world' | 'actors' | 'shaders' | 'terrain';

interface StageDef {
  key: LoadStage;
  /** Share of the bar, 0..1. The four must sum to 1. */
  weight: number;
}

/**
 * What each phase is worth, and the measurements behind the numbers.
 *
 * Timed on the dev server at 1280x800, headless Brave on hardware GL (ANGLE /
 * D3D11 / RTX 3070 Ti), read straight off `__dbgBoot()` — which exists so these
 * can be re-measured on another machine rather than taken on trust:
 *
 *   world      602 ms   createWorld — terrain, the settlement planner, both
 *                       towns, the roads carved into the heightfield, and the
 *                       synchronous 3x3 of chunks around spawn
 *   actors      85 ms   player, combat, HUD, mount, contact particles and the
 *                       ten beast rigs
 *   shaders  13477 ms   the warm-up sweep
 *   terrain   1193 ms   the rest of the streaming ring, drained to empty
 *
 * THE SWEEP IS 88% OF THE BOOT, and the weights say so rather than flattering
 * the bar. That number surprises, so it is worth stating why it is not a bug:
 * ten of its steps redraw the whole scene with one more light than the last, and
 * three keys a shader program on the visible light count — so each of those
 * steps relinks every lit material in the game and the driver blocks the draw
 * call on LINK_STATUS. Measured per step it grows from 0.93 s at one light to
 * 1.63 s at ten, and the remaining seven steps (the towns, the roads, the two
 * underwater programs) cost 9-25 ms each because they link almost nothing. This
 * is the bill the warm-up exists to pay UP FRONT; see warmUpSteps in main.ts.
 *
 * It is also why weighting by the measurement is the right call rather than a
 * cop-out. `shaders` is the one phase that reports fine-grained sub-progress, so
 * giving it the share it actually takes is what makes the bar advance at a
 * roughly even rate; the two phases that can only jump are the two that are
 * over in under a second. A build with a warm shader cache, or a driver that
 * links in the background, shortens `shaders` and the bar simply arrives early —
 * which is the failure direction to prefer.
 */
const STAGES: ReadonlyArray<StageDef> = [
  { key: 'world', weight: 0.08 },
  { key: 'actors', weight: 0.02 },
  { key: 'shaders', weight: 0.78 },
  { key: 'terrain', weight: 0.12 },
];

const LABELS: Record<LoadStage, StringKey> = {
  world: 'load.world',
  actors: 'load.actors',
  shaders: 'load.shaders',
  terrain: 'load.terrain',
};

/**
 * Resolve after the browser has actually PAINTED.
 *
 * A single `requestAnimationFrame` is not enough and the difference matters
 * here more than anywhere else in the codebase: rAF callbacks run BEFORE the
 * frame they belong to is painted, so resuming in the first one and then
 * blocking for a second and a half on `createWorld` delays the very paint the
 * yield was for. The second rAF is the proof that the first frame got out.
 */
const painted = (): Promise<void> =>
  new Promise((res) => {
    requestAnimationFrame(() => requestAnimationFrame(() => res()));
  });

/** One frame, no paint guarantee. Enough between slices of the same phase. */
const nextFrame = (): Promise<void> =>
  new Promise((res) => { requestAnimationFrame(() => res()); });

/** A finished phase, for `__dbgBoot()`. */
export interface StageTiming {
  key: LoadStage;
  ms: number;
}

export class LoadingScreen {
  private el: HTMLDivElement;
  private lbl: HTMLSpanElement;
  private pct: HTMLSpanElement;
  private fill: HTMLElement;
  private unlisten: () => void;

  /** Where the current phase starts on the bar, and how much of it it owns. */
  private base = 0;
  private span = 0;
  private p = 0;
  private stageKey: LoadStage | null = null;
  private stageStart = 0;
  private covering = false;
  private timings: StageTiming[] = [];
  private chipHide = 0;

  constructor() {
    injectStyles();
    const el = document.createElement('div');
    el.className = 'bs-load chip';
    el.innerHTML =
      '<div class="box">' +
        '<div class="cap"><span class="lbl"></span><span class="pct">0%</span></div>' +
        '<div class="track"><i class="fill"></i></div>' +
      '</div>';
    document.body.appendChild(el);
    this.el = el;
    this.lbl = el.querySelector('.lbl') as HTMLSpanElement;
    this.pct = el.querySelector('.pct') as HTMLSpanElement;
    this.fill = el.querySelector('.fill') as HTMLElement;
    // The picker sits in the title screen's Settings, which is open WHILE this
    // is counting. Same treatment the menu's own panel gets: relabel from the
    // event rather than hope nobody switches language mid-boot.
    this.unlisten = onLanguageChange(() => this.relabel());
    requestAnimationFrame(() => el.classList.add('show'));
  }

  /** Timings so far, for the boot probe. Allocates; never called per frame. */
  get stageTimings(): StageTiming[] {
    return this.timings.map((s) => ({ ...s }));
  }

  /** True once New Game has raised the full-screen face. */
  get isCovering(): boolean {
    return this.covering;
  }

  /**
   * Announce the phase about to run and let it be seen before it blocks.
   *
   * The label leads the work rather than following it, which is the only order
   * that says anything useful: the two synchronous phases hold the main thread
   * for a second at a time, and a bar that only moves once they are over
   * describes the past.
   */
  async stage(key: LoadStage): Promise<void> {
    this.closeStage();
    const i = STAGES.findIndex((s) => s.key === key);
    this.base = STAGES.slice(0, Math.max(0, i)).reduce((a, s) => a + s.weight, 0);
    this.span = i >= 0 ? STAGES[i].weight : 0;
    this.stageKey = key;
    this.stageStart = performance.now();
    this.set(this.base, t(LABELS[key]));
    await painted();
  }

  /** Sub-progress within the running phase, 0..1. Monotonic; never rewinds. */
  step(fraction: number): void {
    const f = Math.max(0, Math.min(1, fraction));
    this.set(Math.max(this.p, this.base + this.span * f));
  }

  /**
   * Hand a frame back mid-phase.
   *
   * One rAF, not the double `painted()` above: the caller is slicing its own
   * work small enough that the bar is never more than a frame stale, and paying
   * two frames per slice would double the wall clock of a phase that only
   * yields to keep the page alive.
   */
  breathe(): Promise<void> {
    return nextFrame();
  }

  /**
   * New Game was pressed: become the full screen, under the fading poster.
   *
   * Called from the menu's `onLeave` — the START of its dissolve, not the end —
   * because that is the moment what is behind the poster begins to be seen.
   */
  cover(): void {
    if (this.covering) return;
    this.covering = true;
    window.clearTimeout(this.chipHide);
    this.el.classList.remove('chip');
    this.el.classList.add('cover', 'show');
  }

  /** Everything is built. 100%, and the chip retires itself if it is one. */
  complete(): void {
    this.closeStage();
    this.set(1, t('load.ready'));
    if (this.covering) return;
    // The chip has said its piece. It goes on its own rather than waiting for
    // New Game, so a player who sits on the title screen is not stared at by a
    // full progress bar for the rest of the session.
    this.chipHide = window.setTimeout(() => this.el.classList.remove('show'), 900);
  }

  /** The game is about to be shown: fade off and take the element with it. */
  finish(): void {
    window.clearTimeout(this.chipHide);
    this.el.classList.remove('show');
    this.el.classList.add('gone');
    window.setTimeout(() => this.dispose(), 700);
  }

  dispose(): void {
    window.clearTimeout(this.chipHide);
    this.unlisten();
    this.el.remove();
  }

  private closeStage(): void {
    if (this.stageKey === null) return;
    this.timings.push({
      key: this.stageKey,
      ms: Math.round(performance.now() - this.stageStart),
    });
    this.stageKey = null;
  }

  private relabel(): void {
    this.lbl.textContent = this.p >= 1 ? t('load.ready')
      : this.stageKey ? t(LABELS[this.stageKey]) : this.lbl.textContent;
  }

  private set(p: number, label?: string): void {
    this.p = Math.max(0, Math.min(1, p));
    this.fill.style.width = `${(this.p * 100).toFixed(1)}%`;
    this.pct.textContent = `${Math.round(this.p * 100)}%`;
    if (label !== undefined) this.lbl.textContent = label;
  }
}
