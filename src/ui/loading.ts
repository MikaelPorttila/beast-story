import { t, onLanguageChange, type StringKey } from "../i18n";
import { injectStyles } from "./styles";

/**
 * The boot progress indicator, reporting the work main.ts yields between. TWO
 * FACES, ONE ELEMENT, and the z-index inversion is the trick: the `chip` sits
 * ABOVE the poster (z 55), the full-screen `cover` BELOW it (z 45) so the menu's
 * own dissolve reveals it. Nothing animates on a timer; no minimum dwell.
 */

/** The phases of a cold boot, in the order main.ts runs them. */
export type LoadStage = "world" | "actors" | "shaders" | "terrain";

interface StageDef {
  key: LoadStage;
  /** Share of the bar. The four must sum to 1. */
  weight: number;
}

/**
 * Weighted by measurement: the shader warm-up sweep is ~88% of a cold boot, since
 * each light-count step relinks every lit material. Re-measure with `__dbgBoot()`.
 */
const STAGES: ReadonlyArray<StageDef> = [
  { key: "world", weight: 0.08 },
  { key: "actors", weight: 0.02 },
  { key: "shaders", weight: 0.78 },
  { key: "terrain", weight: 0.12 },
];

const LABELS: Record<LoadStage, StringKey> = {
  world: "load.world",
  actors: "load.actors",
  shaders: "load.shaders",
  terrain: "load.terrain",
};

/** Resolve after a real PAINT: one rAF runs BEFORE its frame, the second proves it. */
const painted = (): Promise<void> =>
  new Promise((res) => {
    requestAnimationFrame(() => requestAnimationFrame(() => res()));
  });

/** One frame, no paint guarantee. */
const nextFrame = (): Promise<void> =>
  new Promise((res) => {
    requestAnimationFrame(() => res());
  });

/** For `__dbgBoot()`. */
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
    const el = document.createElement("div");
    el.className = "bs-load chip";
    el.innerHTML =
      '<div class="box">' +
      '<div class="cap"><span class="lbl"></span><span class="pct">0%</span></div>' +
      '<div class="track"><i class="fill"></i></div>' +
      "</div>";
    document.body.appendChild(el);
    this.el = el;
    this.lbl = el.querySelector(".lbl") as HTMLSpanElement;
    this.pct = el.querySelector(".pct") as HTMLSpanElement;
    this.fill = el.querySelector(".fill") as HTMLElement;
    // The language picker is reachable WHILE this counts.
    this.unlisten = onLanguageChange(() => this.relabel());
    requestAnimationFrame(() => el.classList.add("show"));
  }

  /** Timings so far, for the boot probe. Allocates. */
  get stageTimings(): StageTiming[] {
    return this.timings.map((s) => ({ ...s }));
  }

  /** True once New Game raised the full-screen face. */
  get isCovering(): boolean {
    return this.covering;
  }

  /** Announce the phase before it blocks — a bar that moves after describes the past. */
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

  /** Sub-progress within the running phase. Monotonic. */
  step(fraction: number): void {
    const f = Math.max(0, Math.min(1, fraction));
    this.set(Math.max(this.p, this.base + this.span * f));
  }

  /** Hand a frame back mid-phase. One rAF — `painted()`'s two would double the cost. */
  breathe(): Promise<void> {
    return nextFrame();
  }

  /** Become the full screen, under the fading poster. Called from the menu's `onLeave`. */
  cover(): void {
    if (this.covering) {
      return;
    }
    this.covering = true;
    window.clearTimeout(this.chipHide);
    this.el.classList.remove("chip");
    this.el.classList.add("cover", "show");
  }

  /** 100%, and the chip retires itself if it is one. */
  complete(): void {
    this.closeStage();
    this.set(1, t("load.ready"));
    if (this.covering) {
      return;
    }
    this.chipHide = window.setTimeout(() => this.el.classList.remove("show"), 900);
  }

  /** Fade off and take the element with it. */
  finish(): void {
    window.clearTimeout(this.chipHide);
    this.el.classList.remove("show");
    this.el.classList.add("gone");
    window.setTimeout(() => this.dispose(), 700);
  }

  dispose(): void {
    window.clearTimeout(this.chipHide);
    this.unlisten();
    this.el.remove();
  }

  private closeStage(): void {
    if (this.stageKey === null) {
      return;
    }
    this.timings.push({
      key: this.stageKey,
      ms: Math.round(performance.now() - this.stageStart),
    });
    this.stageKey = null;
  }

  private relabel(): void {
    this.lbl.textContent =
      this.p >= 1
        ? t("load.ready")
        : this.stageKey
          ? t(LABELS[this.stageKey])
          : this.lbl.textContent;
  }

  private set(p: number, label?: string): void {
    this.p = Math.max(0, Math.min(1, p));
    this.fill.style.width = `${(this.p * 100).toFixed(1)}%`;
    this.pct.textContent = `${Math.round(this.p * 100)}%`;
    if (label !== undefined) {
      this.lbl.textContent = label;
    }
  }
}
