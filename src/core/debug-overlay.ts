import type * as THREE from "three";
import { postStats } from "./post";
import { PERF_SECTIONS, perf } from "./profiler";

/**
 * F2 debug overlay. Draw counts rely on Engine disabling `renderer.info.autoReset`:
 * three resets info per render() call and a post frame makes several.
 */
export class DebugOverlay {
  private el: HTMLDivElement;
  private visible = false;

  private samples: number[] = [];
  private lastNow = 0;
  private accum = 0;
  private fps = 0;
  private ms = 0;
  private worst = 0;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private fpsCap = 0,
  ) {
    this.el = document.createElement("div");
    this.el.style.cssText = [
      "position:fixed",
      "top:10px",
      "left:50%",
      "transform:translateX(-50%)",
      "z-index:9999",
      "pointer-events:none",
      "display:none",
      "font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
      "color:#d8f0ff",
      "background:rgba(8,14,22,.82)",
      "border:1px solid rgba(140,200,255,.22)",
      "border-radius:8px",
      "padding:8px 12px",
      "white-space:pre",
      "box-shadow:0 6px 24px rgba(0,0,0,.45)",
      "letter-spacing:.02em",
    ].join(";");
    document.body.appendChild(this.el);
  }

  setFpsCap(cap: number): void {
    this.fpsCap = cap;
  }

  toggle(): void {
    this.visible = !this.visible;
    this.el.style.display = this.visible ? "block" : "none";
    // `hold` cannot switch off a `?perf=1` run.
    perf.hold(this.visible);
    if (this.visible) {
      this.samples.length = 0;
      this.lastNow = 0;
      this.accum = 0;
    }
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** Once per rendered frame, AFTER render(). Measures wall-clock spacing, not sim dt. */
  update(): void {
    const now = performance.now();
    if (this.lastNow > 0) {
      const delta = now - this.lastNow;
      this.samples.push(delta);
      if (this.samples.length > 120) {
        this.samples.shift();
      }
      this.accum += delta;
    }
    this.lastNow = now;
    if (!this.visible) {
      return;
    }

    if (this.accum >= 250 && this.samples.length >= 1) {
      this.accum = 0;
      let sum = 0;
      let worst = 0;
      for (const s of this.samples) {
        sum += s;
        if (s > worst) {
          worst = s;
        }
      }
      this.ms = sum / this.samples.length;
      this.fps = this.ms > 0 ? 1000 / this.ms : 0;
      this.worst = worst;
      this.render();
    }
  }

  private render(): void {
    const info = this.renderer.info;
    // Say "display", not "uncapped": rAF is pinned to the refresh rate.
    const capLine =
      this.fpsCap > 0
        ? `cap    ${this.fpsCap} fps  (?fps=0 to disable)`
        : "cap    display (vsync; ?fps=<n> to cap lower)";
    const low = this.worst > 0 ? 1000 / this.worst : 0;
    // sceneCalls stays 0 when the composer is bypassed (?post=0).
    const post =
      postStats.sceneCalls > 0
        ? `scene  ${String(postStats.sceneCalls).padStart(6)}   +${info.render.calls - postStats.sceneCalls} post ` +
          `(${postStats.passes} passes, ${postStats.bloomObjects} glow)`
        : "scene  (post disabled)";
    this.el.textContent = [
      `FPS    ${this.fps.toFixed(1).padStart(6)}   (${this.ms.toFixed(2)} ms/frame)`,
      `1% low ${low.toFixed(1).padStart(6)}   (worst ${this.worst.toFixed(1)} ms)`,
      capLine,
      `draws  ${String(info.render.calls).padStart(6)}   tris ${info.render.triangles.toLocaleString()}`,
      post,
      `geo ${info.memory.geometries}  tex ${info.memory.textures}`,
      ...this.breakdown(),
      "F2 to hide",
    ].join("\n");
  }

  /** Percentages are of WALL, so `off-cpu` (GPU wait, GC) shows in the same columns. */
  private breakdown(): string[] {
    const m = perf.means(120);
    const wall = m[PERF_SECTIONS.length + 1];
    const cpu = m[PERF_SECTIONS.length];
    if (wall <= 0) {
      return ["", "frame  (sampling…)"];
    }

    const rows: Array<[string, number]> = [];
    for (let i = 0; i < PERF_SECTIONS.length; i++) {
      rows.push([PERF_SECTIONS[i], m[i]]);
    }
    rows.sort((a, b) => b[1] - a[1]);

    const bar = (ms: number): string => {
      const n = Math.round((ms / wall) * 24);
      return "█".repeat(Math.min(24, n)) + "·".repeat(Math.max(0, 24 - n));
    };
    const line = (name: string, ms: number): string =>
      `${name.padEnd(8)}${ms.toFixed(2).padStart(6)} ${String(Math.round((ms / wall) * 100)).padStart(3)}%  ${bar(ms)}`;

    const out = ["", `frame  ${wall.toFixed(2)} ms  ── where it went ──`];
    for (const [name, ms] of rows) {
      out.push(line(name, ms));
    }
    out.push(line("cpu", cpu));
    out.push(line("off-cpu", Math.max(0, wall - cpu)));
    return out;
  }

  dispose(): void {
    this.el.remove();
  }
}
