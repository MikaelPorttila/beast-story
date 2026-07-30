import type * as THREE from 'three';
import { postStats } from './post';

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
    const capLine = this.fpsCap > 0
      ? `cap    ${this.fpsCap} fps  (?fps=0 to disable)`
      : 'cap    none (uncapped)';
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
      `geo ${info.memory.geometries}  tex ${info.memory.textures}      F2 to hide`,
    ].join('\n');
  }

  dispose(): void {
    this.el.remove();
  }
}
