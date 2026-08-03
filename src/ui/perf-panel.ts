/**
 * F3 performance panel: switch parts of the renderer off and watch the frame
 * get cheaper.
 *
 * F2 says a frame costs 6 ms and that `render` is 67% of it. That is a
 * diagnosis and not a remedy — this is the remedy, and the two are meant to be
 * used together: open both, flip a row, watch the number move. Every row
 * carries what it MEASURED at, because a wall of switches with no numbers on it
 * asks the player to guess which one is worth losing.
 *
 * IT IS NOT A MODAL, and that is the single design decision worth arguing.
 * Every other panel in this game freezes the hero (see `modal` in main.ts)
 * because a player who stopped to read should not walk off a cliff. This one
 * must NOT: the whole point is to see the effect on a frame that is doing real
 * work, and a frozen world does not stream chunks, does not animate beasts and
 * does not draw the grass you just switched off. So the hero keeps taking input
 * while it is open — the panel is driven by arrow keys and the mouse, and
 * everything it uses is a key the hero ignores.
 *
 * DOM, like the rest of the HUD, and it deliberately holds no numbers of its
 * own: measuring is F2's job and duplicating it here would be two readouts to
 * keep in step. Class names are `bs-perf-*`; tools/test-gfx.mjs asserts on them.
 */
import { GFX_OPTIONS, type Gfx, type GfxSinks } from '../core/gfx';
import { t } from '../i18n';

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

export class PerfPanel {
  private readonly el: HTMLDivElement;
  private open = false;
  private cursor = 0;

  constructor(private readonly gfx: Gfx) {
    this.el = document.createElement('div');
    this.el.className = 'bs-perf';
    this.el.style.display = 'none';
    document.body.appendChild(this.el);
  }

  get isOpen(): boolean { return this.open; }

  toggle(): void {
    this.open = !this.open;
    this.el.style.display = this.open ? 'block' : 'none';
    if (this.open) this.render();
  }

  /**
   * Arrow keys and Enter, consumed only while the panel is up.
   *
   * Returns whether the key was ours. main.ts uses that to decide whether to
   * let it through — the arrows are not bound to anything the hero does, but
   * saying so explicitly is what stops a future binding colliding silently.
   */
  onKey(code: string): boolean {
    if (!this.open) return false;
    const n = GFX_OPTIONS.length;
    if (code === 'ArrowDown') { this.cursor = (this.cursor + 1) % n; this.render(); return true; }
    if (code === 'ArrowUp') { this.cursor = (this.cursor + n - 1) % n; this.render(); return true; }
    if (code === 'ArrowRight' || code === 'ArrowLeft' || code === 'Enter' || code === 'Space') {
      this.gfx.cycle(GFX_OPTIONS[this.cursor].id);
      this.render();
      return true;
    }
    if (code === 'KeyR') { this.gfx.reset(); this.render(); return true; }
    return false;
  }

  /** Re-read every value and redraw. Called after a console `/gfx` too. */
  refresh(): void {
    if (this.open) this.render();
  }

  private valueLabel(id: keyof GfxSinks): string {
    const v = this.gfx.get(id);
    if (typeof v === 'boolean') return t(v ? 'gfx.on' : 'gfx.off');
    return v === 0 ? t('gfx.uncapped') : String(v);
  }

  private render(): void {
    const rows = GFX_OPTIONS.map((o, i) => {
      const v = this.gfx.get(o.id);
      const off = v === false;
      return (
        `<div class="bs-perf-row${i === this.cursor ? ' sel' : ''}${off ? ' off' : ''}" data-gfx="${o.id}">`
        + `<span class="bs-perf-name">${escapeHtml(t(o.labelKey))}</span>`
        + `<span class="bs-perf-val">${escapeHtml(this.valueLabel(o.id))}</span>`
        + `<span class="bs-perf-cost">${escapeHtml(t(o.costKey))}</span>`
        + '</div>'
      );
    }).join('');
    this.el.innerHTML =
      `<div class="bs-perf-title">${escapeHtml(t('gfx.title'))}</div>`
      + rows
      + `<div class="bs-perf-hint">${escapeHtml(t('gfx.hint'))}</div>`;
  }

  /** A click on a row cycles it, exactly as Enter would. */
  handleClick(target: EventTarget | null): boolean {
    if (!this.open || !(target instanceof Element)) return false;
    const row = target.closest('.bs-perf-row') as HTMLElement | null;
    if (!row) return false;
    const id = row.getAttribute('data-gfx') as keyof GfxSinks | null;
    if (!id) return false;
    this.cursor = GFX_OPTIONS.findIndex((o) => o.id === id);
    this.gfx.cycle(id);
    this.render();
    return true;
  }

  /** Re-label after a language switch, the same contract HUD.relabel has. */
  relabel(): void {
    if (this.open) this.render();
  }

  dispose(): void {
    this.el.remove();
  }
}
