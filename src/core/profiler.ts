/**
 * Opt-in frame profiler (`?perf=1`). `cpu` = time in our frame callback,
 * `wall` = begin()-to-begin(); wall - cpu is GPU wait, compositing or GC.
 * Ring buffer of plain numbers — allocating would perturb the GC it observes.
 */

export const PERF_SECTIONS = [
  "input",
  "player",
  "beasts",
  "world",
  "combat",
  "hud",
  "render",
  "map",
  "overlay",
] as const;
export type PerfSection = (typeof PERF_SECTIONS)[number];

/** `programs` counts WebGL links: a first-ever draw links synchronously, stalling the driver. */
export const PERF_COUNTERS = ["chunks", "enemies", "programs"] as const;
export type PerfCounter = (typeof PERF_COUNTERS)[number];

const SECTION_INDEX = new Map<string, number>(PERF_SECTIONS.map((s, i) => [s, i]));
const COUNTER_INDEX = new Map<string, number>(PERF_COUNTERS.map((c, i) => [c, i]));

/** ~100 s at 60 fps. */
const CAP = 6000;
/** sections + cpu total + wall total */
const STRIDE = PERF_SECTIONS.length + 2;
const CPU_SLOT = PERF_SECTIONS.length;
const WALL_SLOT = PERF_SECTIONS.length + 1;

class Profiler {
  /** `pinned` exists so `hold(false)` cannot switch off a `?perf=1` run. */
  enabled = false;
  private pinned = false;

  private buf = new Float64Array(CAP * STRIDE);
  private cbuf = new Int32Array(CAP * PERF_COUNTERS.length);
  private meanBuf = new Float64Array(STRIDE);
  private frames = 0;
  private frameStart = 0;
  private mark = 0;
  private prevStart = 0;

  pin(): void {
    this.pinned = true;
    this.enabled = true;
  }

  hold(on: boolean): void {
    this.enabled = this.pinned || on;
  }

  /** Means in ms, indexed like a `dump()` row. Returns a REUSED buffer. */
  means(window = 120): Float64Array {
    const out = this.meanBuf;
    out.fill(0);
    const n = Math.min(this.frames, CAP, window);
    if (n === 0) {
      return out;
    }
    for (let k = 1; k <= n; k++) {
      const f = (((this.frames - k) % CAP) + CAP) % CAP;
      for (let i = 0; i < STRIDE; i++) {
        out[i] += this.buf[f * STRIDE + i];
      }
    }
    for (let i = 0; i < STRIDE; i++) {
      out[i] /= n;
    }
    return out;
  }

  /** First thing in the frame callback. */
  begin(): void {
    if (!this.enabled) {
      return;
    }
    const now = performance.now();
    const row = (this.frames % CAP) * STRIDE;
    this.buf.fill(0, row, row + STRIDE);
    const crow = (this.frames % CAP) * PERF_COUNTERS.length;
    this.cbuf.fill(0, crow, crow + PERF_COUNTERS.length);
    this.buf[row + WALL_SLOT] = this.prevStart > 0 ? now - this.prevStart : 0;
    this.prevStart = now;
    this.frameStart = now;
    this.mark = now;
  }

  section(name: PerfSection): void {
    if (!this.enabled) {
      return;
    }
    const now = performance.now();
    const i = SECTION_INDEX.get(name);
    if (i !== undefined) {
      this.buf[(this.frames % CAP) * STRIDE + i] += now - this.mark;
    }
    this.mark = now;
  }

  count(name: PerfCounter, n = 1): void {
    if (!this.enabled) {
      return;
    }
    const i = COUNTER_INDEX.get(name);
    if (i !== undefined) {
      this.cbuf[(this.frames % CAP) * PERF_COUNTERS.length + i] += n;
    }
  }

  /** Last in the frame callback. */
  end(): void {
    if (!this.enabled) {
      return;
    }
    const row = (this.frames % CAP) * STRIDE;
    this.buf[row + CPU_SLOT] = performance.now() - this.frameStart;
    this.frames++;
  }

  /** Oldest-first rows. Allocates — harness only, never the frame loop. */
  dump(): { sections: string[]; counters: string[]; rows: number[][] } {
    const n = Math.min(this.frames, CAP);
    const first = this.frames > CAP ? this.frames % CAP : 0;
    const rows: number[][] = [];
    for (let k = 0; k < n; k++) {
      const f = (first + k) % CAP;
      const row: number[] = [];
      for (let i = 0; i < STRIDE; i++) {
        row.push(+this.buf[f * STRIDE + i].toFixed(3));
      }
      for (let i = 0; i < PERF_COUNTERS.length; i++) {
        row.push(this.cbuf[f * PERF_COUNTERS.length + i]);
      }
      rows.push(row);
    }
    return {
      sections: [...PERF_SECTIONS, "cpu", "wall"],
      counters: [...PERF_COUNTERS],
      rows,
    };
  }

  reset(): void {
    this.frames = 0;
    this.prevStart = 0;
  }
}

export const perf = new Profiler();
