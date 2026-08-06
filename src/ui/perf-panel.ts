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
import type { StringKey } from '../i18n';

export interface TimeOfDayControl {
  readonly presets: readonly { phase: number | null; labelKey: StringKey }[];
  get(): number | null;
  set(phase: number | null): void;
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

export class PerfPanel {
  private readonly el: HTMLDivElement;
  private open = false;
  private cursor = 0;

  constructor(private readonly gfx: Gfx, private readonly time: TimeOfDayControl) {
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
    const n = GFX_OPTIONS.length + 1;
    if (code === 'ArrowDown') { this.cursor = (this.cursor + 1) % n; this.render(); return true; }
    if (code === 'ArrowUp') { this.cursor = (this.cursor + n - 1) % n; this.render(); return true; }
    if (code === 'ArrowRight' || code === 'ArrowLeft' || code === 'Enter' || code === 'Space') {
      if (this.cursor === GFX_OPTIONS.length) this.cycleTime(code === 'ArrowLeft' ? -1 : 1);
      else this.gfx.cycle(GFX_OPTIONS[this.cursor].id);
      this.render();
      return true;
    }
    if (code === 'KeyR') {
      this.gfx.reset();
      this.time.set(null);
      this.render();
      return true;
    }
    return false;
  }

  /** Re-read every value and redraw. Called after a console `/gfx` too. */
  refresh(): void {
    if (this.open) this.render();
  }

  private valueLabel(id: keyof GfxSinks): string {
    const v = this.gfx.get(id);
    if (typeof v === 'boolean') return t(v ? 'gfx.on' : 'gfx.off');
    if (id === 'terrainDistance') {
      return t(v === 480 ? 'gfx.distance.low' : v === 600 ? 'gfx.distance.medium' : 'gfx.distance.high');
    }
    if (id === 'foliageDistance') {
      return t(v === 64 ? 'gfx.distance.low' : v === 96 ? 'gfx.distance.medium' : 'gfx.distance.high');
    }
    return v === 0 ? t('gfx.uncapped') : String(v);
  }

  private timeLabel(): string {
    const value = this.time.get();
    return t(this.time.presets.find((p) => p.phase === value)?.labelKey ?? 'gfx.time.auto');
  }

  private cycleTime(step: number): void {
    const value = this.time.get();
    let i = this.time.presets.findIndex((p) => p.phase === value);
    if (i < 0) i = 0;
    i = (i + step + this.time.presets.length) % this.time.presets.length;
    this.time.set(this.time.presets[i].phase);
  }

  private render(): void {
    const gfxRows = GFX_OPTIONS.map((o, i) => {
      const v = this.gfx.get(o.id);
      const off = v === false;
      return (
        // `data-cursor` explicitly: a row is a clickable control but it is a
        // div, so nothing about its tag says so — the resolver in ui/cursor.ts
        // reads BUTTON and [data-act], and a row has neither.
        `<div class="bs-perf-row${i === this.cursor ? ' sel' : ''}${off ? ' off' : ''}"`
        + ` data-cursor="link-select" data-gfx="${o.id}">`
        + `<span class="bs-perf-name">${escapeHtml(t(o.labelKey))}</span>`
        + `<span class="bs-perf-val">${escapeHtml(this.valueLabel(o.id))}</span>`
        + `<span class="bs-perf-cost">${escapeHtml(t(o.costKey))}</span>`
        + '</div>'
      );
    }).join('');
    const timeRow = `<div class="bs-perf-row${this.cursor === GFX_OPTIONS.length ? ' sel' : ''}"`
      + ' data-cursor="link-select" data-time="day">'
      + `<span class="bs-perf-name">${escapeHtml(t('gfx.timeOfDay'))}</span>`
      + `<span class="bs-perf-val">${escapeHtml(this.timeLabel())}</span>`
      + `<span class="bs-perf-cost">${escapeHtml(t('gfx.timeOfDay.cost'))}</span>`
      + '</div>';
    const rows = gfxRows + timeRow;
    this.el.innerHTML =
      // The bar you pick the panel up by. `grab` on hover and `grabbing` while
      // dragging is the pair the cursor sheet draws — see ui/cursor.ts.
      `<div class="bs-perf-title" data-cursor="grab" data-drag="move">`
      + `${escapeHtml(t('gfx.title'))}</div>`
      // The rows scroll, THE PANEL DOES NOT. `overflow` on the panel itself
      // clips the resize handles that sit on its edges, and worse, its
      // scrollbar lands exactly where the east and south-east handles are — so
      // the hit test found the scrollbar and the corner could not be grabbed.
      + `<div class="bs-perf-body">${rows}</div>`
      + `<div class="bs-perf-hint">${escapeHtml(t('gfx.hint'))}</div>`
      // EIGHT HANDLES, and each one names its own cursor. Four edges and four
      // corners is what makes `resize-horizontal`, `resize-vertical`,
      // `resize-nwse` and `resize-nesw` four different answers rather than one
      // generic "resize" — the diagonals differ by which way the arrow runs,
      // which is only meaningful if the corner it sits on agrees.
      + '<i class="bs-perf-h n"  data-cursor="resize-vertical"   data-drag="n"></i>'
      + '<i class="bs-perf-h s"  data-cursor="resize-vertical"   data-drag="s"></i>'
      + '<i class="bs-perf-h w"  data-cursor="resize-horizontal" data-drag="w"></i>'
      + '<i class="bs-perf-h e"  data-cursor="resize-horizontal" data-drag="e"></i>'
      + '<i class="bs-perf-h nw" data-cursor="resize-nwse"       data-drag="nw"></i>'
      + '<i class="bs-perf-h se" data-cursor="resize-nwse"       data-drag="se"></i>'
      + '<i class="bs-perf-h ne" data-cursor="resize-nesw"       data-drag="ne"></i>'
      + '<i class="bs-perf-h sw" data-cursor="resize-nesw"       data-drag="sw"></i>';
  }

  /**
   * Pick the panel up, or take hold of one of its edges.
   *
   * WHY THE PANEL MOVES AT ALL. It is not decoration and it is not there to
   * exercise the cursor: F3 sits top-left and F2 top-centre, and the whole point
   * of the pair is reading them together — on a narrow window they overlap, and
   * on a wide one the thing you want to watch while flipping a row might be
   * anywhere. A debug panel you cannot move is a debug panel that covers the
   * thing you are debugging.
   *
   * The drag is tracked on WINDOW, not on the handle, for the usual reason: a
   * fast drag outruns the element under the pointer, and a listener bound to the
   * handle stops receiving moves the moment it does.
   */
  private beginDrag(e: MouseEvent, mode: string): void {
    const r = this.el.getBoundingClientRect();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const start = { left: r.left, top: r.top, w: r.width, h: r.height };
    // Pin the cursor for the whole drag: the pointer leaves the 6px handle
    // almost immediately, and without this it would snap back to `default`
    // mid-resize and read as broken while working perfectly.
    this.onDragCursor?.(mode === 'move' ? 'grabbing' : null, true);

    const move = (ev: MouseEvent): void => {
      const dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      if (mode === 'move') {
        this.place(start.left + dx, start.top + dy, start.w, start.h);
        return;
      }
      let { left, top, w, h } = start;
      if (mode.includes('e')) w = start.w + dx;
      if (mode.includes('s')) h = start.h + dy;
      if (mode.includes('w')) { w = start.w - dx; left = start.left + dx; }
      if (mode.includes('n')) { h = start.h - dy; top = start.top + dy; }
      this.place(left, top, w, h);
    };
    const up = (): void => {
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', up, true);
      this.onDragCursor?.(null, false);
    };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', up, true);
  }

  /**
   * Put the panel somewhere, clamped so it can never be lost off screen.
   *
   * The minimum width is what the longest cost string needs to stay on one
   * line; the minimum height keeps the title and at least a row visible, so a
   * panel dragged to nothing can always be dragged back out.
   */
  private place(left: number, top: number, w: number, h: number): void {
    const W = Math.max(260, Math.min(w, window.innerWidth));
    const H = Math.max(70, Math.min(h, window.innerHeight));
    const L = Math.max(0, Math.min(left, window.innerWidth - 60));
    const T = Math.max(0, Math.min(top, window.innerHeight - 30));
    this.el.style.left = `${L}px`;
    this.el.style.top = `${T}px`;
    this.el.style.width = `${W}px`;
    this.el.style.height = `${H}px`;
  }

  /** Set by main.ts so a drag can pin the cursor. See CursorDirector.lock. */
  onDragCursor: ((state: string | null, dragging: boolean) => void) | null = null;

  /** A click on a row cycles it, exactly as Enter would. */
  handleClick(target: EventTarget | null, event?: MouseEvent): boolean {
    if (!this.open || !(target instanceof Element)) return false;
    // A handle or the title bar starts a drag instead of toggling anything.
    const drag = target.closest('[data-drag]') as HTMLElement | null;
    if (drag && event) {
      this.beginDrag(event, drag.getAttribute('data-drag') ?? 'move');
      return true;
    }
    const row = target.closest('.bs-perf-row') as HTMLElement | null;
    if (!row) return false;
    const id = row.getAttribute('data-gfx') as keyof GfxSinks | null;
    if (!id && row.hasAttribute('data-time')) {
      this.cursor = GFX_OPTIONS.length;
      this.cycleTime(1);
      this.render();
      return true;
    }
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
