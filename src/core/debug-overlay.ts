import type * as THREE from 'three';
import { postStats } from './post';
import { PERF_SECTIONS, perf } from './profiler';

/**
 * F2 debug overlay: measured frame rate (not the cap — actually observed),
 * frame time, the configured cap, and renderer load. Hidden by default.
 *
 * Draw calls need a word of explanation. Engine turns off
 * `renderer.info.autoReset` and clears the counters once per frame, because
 * renderer.info resets itself on every render() call and a post-processing
 * frame makes several — left alone, the readout showed the cost of one
 * fullscreen quad. So `draws` here is the honest per-frame total, and the
 * `scene` line separates out what the world itself cost (sampled by
 * post.ts's StatsProbePass) from what post-processing added on top.
 */
export class DebugOverlay {
  private el: HTMLDivElement;
  private visible = false;

  // rolling window of recent frame times (ms)
  private samples: number[] = [];
  private lastNow = 0;
  private accum = 0;
  private fps = 0;
  private ms = 0;
  private worst = 0;

  constructor(private renderer: THREE.WebGLRenderer, private fpsCap = 0) {
    this.el = document.createElement('div');
    this.el.style.cssText = [
      'position:fixed', 'top:10px', 'left:50%', 'transform:translateX(-50%)',
      'z-index:9999', 'pointer-events:none', 'display:none',
      'font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
      'color:#d8f0ff', 'background:rgba(8,14,22,.82)', 'border:1px solid rgba(140,200,255,.22)',
      'border-radius:8px', 'padding:8px 12px', 'white-space:pre',
      'box-shadow:0 6px 24px rgba(0,0,0,.45)', 'letter-spacing:.02em',
    ].join(';');
    document.body.appendChild(this.el);
  }

  setFpsCap(cap: number): void {
    this.fpsCap = cap;
  }

  toggle(): void {
    this.visible = !this.visible;
    this.el.style.display = this.visible ? 'block' : 'none';
    // Sampling costs ten performance.now() calls a frame, so it is paid only
    // while somebody is looking. `hold` cannot switch off a `?perf=1` run.
    perf.hold(this.visible);
    if (this.visible) {
      // start clean so the first reading isn't skewed by time spent hidden
      this.samples.length = 0;
      this.lastNow = 0;
      this.accum = 0;
    }
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /**
   * Call once per rendered frame, AFTER render(). Measures wall-clock frame
   * spacing itself rather than trusting the simulation dt, so a capped or
   * stuttering frame shows its true cost.
   */
  update(): void {
    const now = performance.now();
    if (this.lastNow > 0) {
      const delta = now - this.lastNow;
      this.samples.push(delta);
      if (this.samples.length > 120) this.samples.shift();
      this.accum += delta;
    }
    this.lastNow = now;
    if (!this.visible) return;

    // refresh the readout ~4x/second so the numbers stay readable (but show
    // something on the very first measured frame rather than staying blank)
    if (this.accum >= 250 && this.samples.length >= 1) {
      this.accum = 0;
      let sum = 0;
      let worst = 0;
      for (const s of this.samples) {
        sum += s;
        if (s > worst) worst = s;
      }
      this.ms = sum / this.samples.length;
      this.fps = this.ms > 0 ? 1000 / this.ms : 0;
      this.worst = worst;
      this.render();
    }
  }

  private render(): void {
    const info = this.renderer.info;
    // "uncapped" meant "no cap of OURS", and read as "runs unbounded" — which
    // sent one performance investigation down a blind alley. A browser pins
    // requestAnimationFrame to the display, so with no cap of our own the frame
    // rate IS the refresh rate, the frame COUNT is fixed, and a cheaper frame is
    // straightforwardly less CPU. The wording matters because the opposite
    // reading suggests capping as the fix, when the machine already caps it.
    const capLine = this.fpsCap > 0
      ? `cap    ${this.fpsCap} fps  (?fps=0 to disable)`
      : 'cap    display (vsync; ?fps=<n> to cap lower)';
    const low = this.worst > 0 ? 1000 / this.worst : 0;
    // postStats.sceneCalls stays 0 when the composer is bypassed (?post=0), in
    // which case the total IS the scene cost and the split line is noise.
    const post = postStats.sceneCalls > 0
      ? `scene  ${String(postStats.sceneCalls).padStart(6)}   +${info.render.calls - postStats.sceneCalls} post `
        + `(${postStats.passes} passes, ${postStats.bloomObjects} glow)`
      : 'scene  (post disabled)';
    this.el.textContent = [
      `FPS    ${this.fps.toFixed(1).padStart(6)}   (${this.ms.toFixed(2)} ms/frame)`,
      `1% low ${low.toFixed(1).padStart(6)}   (worst ${this.worst.toFixed(1)} ms)`,
      capLine,
      `draws  ${String(info.render.calls).padStart(6)}   tris ${info.render.triangles.toLocaleString()}`,
      post,
      `geo ${info.memory.geometries}  tex ${info.memory.textures}`,
      ...this.breakdown(),
      'F2 to hide',
    ].join('\n');
  }

  /**
   * WHERE THE FRAME WENT, which is the question the numbers above cannot answer.
   *
   * FPS and draw calls say a frame is expensive; they never say which subsystem
   * spent it, and the answer is rarely the one you would guess — measured on
   * this project, `render` is 95% of our CPU and every gameplay system together
   * is under 0.2 ms. Without this you optimise the thing you were thinking about
   * rather than the thing that costs.
   *
   * THE LAST LINE IS THE IMPORTANT ONE. `cpu` is time inside our own frame
   * callback; `off-cpu` is wall minus cpu — time the frame took that WE DID NOT
   * SPEND. That is GPU work being waited on, compositing, or a collection, and
   * no amount of making our JavaScript faster will move it. A frame that is
   * mostly off-cpu and a frame that is mostly render need opposite fixes, and
   * this is the only line that tells them apart.
   *
   * Percentages are of WALL, not of cpu, so the columns add up to the frame the
   * player actually got.
   */
  private breakdown(): string[] {
    const m = perf.means(120);
    const wall = m[PERF_SECTIONS.length + 1];
    const cpu = m[PERF_SECTIONS.length];
    // Before the profiler has a frame in it there is nothing honest to draw.
    if (wall <= 0) return ['', 'frame  (sampling…)'];

    const rows: Array<[string, number]> = [];
    for (let i = 0; i < PERF_SECTIONS.length; i++) rows.push([PERF_SECTIONS[i], m[i]]);
    rows.sort((a, b) => b[1] - a[1]);

    const bar = (ms: number): string => {
      const n = Math.round((ms / wall) * 24);
      return '█'.repeat(Math.min(24, n)) + '·'.repeat(Math.max(0, 24 - n));
    };
    const line = (name: string, ms: number): string =>
      `${name.padEnd(8)}${ms.toFixed(2).padStart(6)} ${String(Math.round((ms / wall) * 100)).padStart(3)}%  ${bar(ms)}`;

    const out = ['', `frame  ${wall.toFixed(2)} ms  ── where it went ──`];
    for (const [name, ms] of rows) {
      // Below a hundredth of a millisecond the bar is empty and the row is
      // noise; naming them anyway is what makes "it is not gameplay" visible.
      out.push(line(name, ms));
    }
    out.push(line('cpu', cpu));
    out.push(line('off-cpu', Math.max(0, wall - cpu)));
    return out;
  }

  dispose(): void {
    this.el.remove();
  }
}
