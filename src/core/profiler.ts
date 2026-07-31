/**
 * Opt-in frame profiler (`?perf=1`), for attributing a frame's cost to the
 * subsystem that spent it. Off by default and effectively free when off: every
 * entry point returns on a boolean before it reads the clock.
 *
 * It records two totals per frame, and the difference between them is the whole
 * reason this exists:
 *
 *   cpu   time spent inside our own frame callback, split across the sections
 *         below. A stall here is our code — a chunk build, a rig rebuild, a
 *         synchronous shader link inside render().
 *   wall  begin()-to-begin() spacing, i.e. what the player actually feels. Time
 *         that is in `wall` but not in `cpu` was spent outside our callback:
 *         GPU work we are waiting on, compositing, or a garbage collection.
 *
 * A hitch that shows up in `wall` alone is not fixed by making our code faster,
 * and a hitch in one section is not fixed by decoupling loops. Measure first.
 *
 * Storage is a preallocated ring buffer of plain numbers — no per-frame
 * allocation, because a profiler that produces garbage changes the very GC
 * behaviour it is meant to observe.
 */

export const PERF_SECTIONS = [
  'input', 'player', 'beasts', 'world', 'combat', 'hud', 'render', 'overlay',
] as const;
export type PerfSection = (typeof PERF_SECTIONS)[number];

/**
 * Per-frame event tallies, so a spike can be tied to what happened in it.
 *
 * `programs` is the number of WebGL programs three linked during the frame.
 * It is here because a first-ever draw of some material/geometry combination
 * links a program synchronously, and the driver can sit on that for hundreds of
 * milliseconds — a stall that looks like "render is slow" but is really "this
 * shader had never been compiled before".
 */
export const PERF_COUNTERS = ['chunks', 'enemies', 'programs'] as const;
export type PerfCounter = (typeof PERF_COUNTERS)[number];

const SECTION_INDEX = new Map<string, number>(PERF_SECTIONS.map((s, i) => [s, i]));
const COUNTER_INDEX = new Map<string, number>(PERF_COUNTERS.map((c, i) => [c, i]));

/** ~100 s at 60 fps. Long enough to catch a rare freeze in a scripted run. */
const CAP = 6000;
/** sections + cpu total + wall total */
const STRIDE = PERF_SECTIONS.length + 2;
const CPU_SLOT = PERF_SECTIONS.length;
const WALL_SLOT = PERF_SECTIONS.length + 1;

class Profiler {
  enabled = false;

  private buf = new Float64Array(CAP * STRIDE);
  private cbuf = new Int32Array(CAP * PERF_COUNTERS.length);
  private frames = 0;
  private frameStart = 0;
  private mark = 0;
  private prevStart = 0;

  /** Call first thing in the frame callback. */
  begin(): void {
    if (!this.enabled) return;
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

  /** Attribute everything since the previous mark to `name`. */
  section(name: PerfSection): void {
    if (!this.enabled) return;
    const now = performance.now();
    const i = SECTION_INDEX.get(name);
    if (i !== undefined) this.buf[(this.frames % CAP) * STRIDE + i] += now - this.mark;
    this.mark = now;
  }

  /** Tally an event against the frame it happened in. */
  count(name: PerfCounter, n = 1): void {
    if (!this.enabled) return;
    const i = COUNTER_INDEX.get(name);
    if (i !== undefined) this.cbuf[(this.frames % CAP) * PERF_COUNTERS.length + i] += n;
  }

  /** Call last in the frame callback. */
  end(): void {
    if (!this.enabled) return;
    const row = (this.frames % CAP) * STRIDE;
    this.buf[row + CPU_SLOT] = performance.now() - this.frameStart;
    this.frames++;
  }

  /**
   * Frames in chronological order, oldest first, as plain rows. Allocates — it
   * is called once from a test harness, never from the frame loop.
   */
  dump(): { sections: string[]; counters: string[]; rows: number[][] } {
    const n = Math.min(this.frames, CAP);
    const first = this.frames > CAP ? this.frames % CAP : 0;
    const rows: number[][] = [];
    for (let k = 0; k < n; k++) {
      const f = (first + k) % CAP;
      const row: number[] = [];
      for (let i = 0; i < STRIDE; i++) row.push(+this.buf[f * STRIDE + i].toFixed(3));
      for (let i = 0; i < PERF_COUNTERS.length; i++) row.push(this.cbuf[f * PERF_COUNTERS.length + i]);
      rows.push(row);
    }
    return {
      sections: [...PERF_SECTIONS, 'cpu', 'wall'],
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
