/**
 * F3 DEBUG PANEL: switch parts of the renderer off and watch the frame get
 * cheaper — and conjure the thing you are trying to look at.
 *
 * F2 says a frame costs 6 ms and that `render` is 67% of it. That is a
 * diagnosis and not a remedy — the top half of this panel is the remedy, and
 * the two are meant to be used together: open both, flip a row, watch the
 * number move. Every row carries what it MEASURED at, because a wall of
 * switches with no numbers on it asks the player to guess which one is worth
 * losing.
 *
 * THE BOTTOM HALF IS A SPAWNER, and it is here rather than in the dev console
 * because of what the console cannot do: `/give` needs you to already know the
 * id. Ninety ids across items, beasts, enemies and settlement parts is a set
 * you BROWSE, not one you remember — so it is a tree with a search box over it,
 * and the console commands stay as the scriptable half of the same catalogue.
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
 * THE SEARCH BOX IS THE ONE EXCEPTION, and it is exactly as narrow as it has to
 * be. A focused text field wants the letters, and `WASD` are letters — so while
 * it holds focus this swallows the keystroke in the CAPTURE phase, the same
 * trick and the same reason as ui/console.ts, and `isTyping` tells main.ts to
 * suspend gameplay input for as long as that lasts. Click away or press Escape
 * and the hero has the keyboard back; the world never stopped either way.
 *
 * DOM, like the rest of the HUD, and it deliberately holds no numbers of its
 * own: measuring is F2's job and duplicating it here would be two readouts to
 * keep in step. Class names are `bs-perf-*` and `bs-spawn-*`; tools/test-gfx.mjs
 * and tools/test-spawn.mjs assert on them.
 */
import { GFX_OPTIONS, type Gfx, type GfxSinks } from '../core/gfx';
import { spawnMatches, type SpawnBranch, type SpawnCatalogue, type SpawnRow } from '../core/spawn';
import { t } from '../i18n';
import type { StringKey } from '../i18n';

export interface TimeOfDayControl {
  readonly presets: readonly { phase: number | null; labelKey: StringKey }[];
  get(): number | null;
  set(phase: number | null): void;
}

/**
 * The hero's hair: which style, and what colour.
 *
 * IT IS NOT A RENDERING TOGGLE, and it is here anyway. Everything above it in
 * this panel answers "what is this costing?"; a hairstyle costs nothing and
 * changes nothing but him. It is here because this is where a thing you want to
 * SEE gets conjured — the same argument the spawner below it makes — and
 * because the panel is the only surface in the game that can offer it today.
 * Its real home is a character creator, which is why it is injected exactly as
 * `TimeOfDayControl` is: this file owns two rows and no policy, and the host
 * (main.ts) owns what a change means and where it is stored.
 */
export interface AppearanceControl {
  readonly styles: readonly { id: string; labelKey: StringKey }[];
  /** The strip the arrow keys step through. Any other colour comes from the well. */
  readonly swatches: readonly number[];
  style(): string;
  setStyle(id: string): void;
  colour(): number;
  setColour(hex: number): void;
  /** Back to the first style in its own colour — the panel's R key. */
  reset(): void;
}

/** The rows below the gfx list, in the order they are drawn. */
const ROW_TIME = GFX_OPTIONS.length;
const ROW_STYLE = ROW_TIME + 1;
const ROW_COLOUR = ROW_TIME + 2;
const EXTRA_ROWS = 3;

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

export class PerfPanel {
  private readonly el: HTMLDivElement;
  private open = false;
  private cursor = 0;
  /**
   * The three persistent children `render()` writes into.
   *
   * THE SHELL IS BUILT ONCE and only these are re-generated, which is not a
   * micro-optimisation — it is what keeps the search field alive. The panel used
   * to redraw itself with a single `innerHTML` assignment, and doing that to a
   * focused input destroys the element, the focus and the caret with it: one
   * keystroke per redraw, and the redraw is per keystroke.
   */
  private gfxList: HTMLDivElement | null = null;
  private treeEl: HTMLDivElement | null = null;
  private statusEl: HTMLDivElement | null = null;
  private searchEl: HTMLInputElement | null = null;
  /** Which branches are open. Collapsed by default — see `render`. */
  private expanded = new Set<string>();
  private status = '';
  private typing = false;

  constructor(
    private readonly gfx: Gfx,
    private readonly time: TimeOfDayControl,
    private readonly catalogue: SpawnCatalogue,
    private readonly look: AppearanceControl,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'bs-perf';
    this.el.style.display = 'none';
    document.body.appendChild(this.el);
    // Capture phase, ahead of core/input.ts's own window listener, so a letter
    // typed into the search box does not also make the hero strafe. Only while
    // the field actually has focus — the arrow keys below still belong to the
    // gfx rows the rest of the time. See ui/console.ts for the same pattern.
    window.addEventListener('keydown', (e) => this.onSearchKey(e), true);
    // A WHEEL OVER THE PANEL SCROLLS THE PANEL AND NOTHING ELSE. `Input` listens
    // for wheel on window in the bubble phase and spends every notch on the
    // camera's zoom, so scrolling the spawner tree walked the lens in and out
    // behind it. Capture-phase `stopPropagation` is the same fix and the same
    // shape as the keydown above; NOT `preventDefault`, because the scroll this
    // is protecting is the browser's own on `.bs-perf-body`.
    window.addEventListener('wheel', (e) => {
      if (!this.open || !(e.target instanceof Node) || !this.el.contains(e.target)) return;
      e.stopPropagation();
    }, true);
  }

  get isOpen(): boolean { return this.open; }

  /**
   * True while the search box owns the keyboard.
   *
   * main.ts folds it into `modal`, which suspends gameplay input for the slice
   * — NOT the clock (issue #101). The hero stops taking orders and goes on
   * falling, landing and being shot at, which is the whole bargain every other
   * panel in the game makes.
   */
  get isTyping(): boolean { return this.typing; }

  toggle(): void {
    this.open = !this.open;
    // `flex`, NOT `block`. The stylesheet lays the panel out as a column so the
    // title and the hint stay put while the body scrolls between them — and an
    // inline `display:block` beat that declaration, so the body never shrank
    // and the whole column simply grew past the bottom of the window. It did
    // not show while the panel was eleven rows tall; it showed the moment the
    // spawner made it ninety.
    this.el.style.display = this.open ? 'flex' : 'none';
    if (this.open) {
      this.buildShell();
      this.render();
    } else {
      this.blurSearch();
    }
  }

  /**
   * Arrow keys and Enter, consumed only while the panel is up.
   *
   * Returns whether the key was ours. main.ts uses that to decide whether to
   * let it through — the arrows are not bound to anything the hero does, but
   * saying so explicitly is what stops a future binding colliding silently.
   * main.ts does not offer them at all while `isTyping`, because inside a text
   * field an arrow key is a caret move.
   */
  onKey(code: string): boolean {
    if (!this.open) return false;
    const n = GFX_OPTIONS.length + EXTRA_ROWS;
    if (code === 'ArrowDown') { this.cursor = (this.cursor + 1) % n; this.render(); return true; }
    if (code === 'ArrowUp') { this.cursor = (this.cursor + n - 1) % n; this.render(); return true; }
    if (code === 'ArrowRight' || code === 'ArrowLeft' || code === 'Enter' || code === 'Space') {
      const step = code === 'ArrowLeft' ? -1 : 1;
      if (this.cursor === ROW_TIME) this.cycleTime(step);
      else if (this.cursor === ROW_STYLE) this.cycleStyle(step);
      else if (this.cursor === ROW_COLOUR) this.cycleColour(step);
      else this.gfx.cycle(GFX_OPTIONS[this.cursor].id);
      this.render();
      return true;
    }
    if (code === 'KeyR') {
      this.gfx.reset();
      this.time.set(null);
      this.look.reset();
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

  private cycleStyle(step: number): void {
    const list = this.look.styles;
    const i = Math.max(0, list.findIndex((s) => s.id === this.look.style()));
    this.look.setStyle(list[(i + step + list.length) % list.length].id);
  }

  /**
   * Step along the swatch strip. A colour that is not ON the strip — one picked
   * out of the well — lands on the nearest swatch and carries on from there,
   * which is what makes the arrows still useful after a free pick instead of
   * snapping back to the first entry.
   */
  private cycleColour(step: number): void {
    const list = this.look.swatches;
    const now = this.look.colour();
    let at = list.indexOf(now);
    if (at < 0) {
      let best = Infinity;
      list.forEach((hex, i) => {
        const d = Math.abs((hex >> 16 & 255) - (now >> 16 & 255))
          + Math.abs((hex >> 8 & 255) - (now >> 8 & 255))
          + Math.abs((hex & 255) - (now & 255));
        if (d < best) { best = d; at = i; }
      });
    }
    this.look.setColour(list[(at + step + list.length) % list.length]);
  }

  /** `#rrggbb`, which is the only form an `<input type="color">` accepts. */
  private static hex(value: number): string {
    return `#${value.toString(16).padStart(6, '0')}`;
  }

  private styleLabel(): string {
    const s = this.look.styles.find((o) => o.id === this.look.style());
    return s ? t(s.labelKey) : this.look.style();
  }

  /**
   * The parts of the panel that never change: the drag bar, the two section
   * headings, the search field, the hint and the eight resize handles.
   *
   * Rebuilt on open and on a language switch, and at no other time. The search
   * box is created here exactly once per open, which is what lets `render()`
   * run on every keystroke without the caret jumping.
   */
  private buildShell(): void {
    this.el.innerHTML =
      // The bar you pick the panel up by. `grab` on hover and `grabbing` while
      // dragging is the pair the cursor sheet draws — see ui/cursor.ts.
      '<div class="bs-perf-title" data-cursor="grab" data-drag="move">'
      + `${escapeHtml(t('gfx.title'))}</div>`
      // The rows scroll, THE PANEL DOES NOT. `overflow` on the panel itself
      // clips the resize handles that sit on its edges, and worse, its
      // scrollbar lands exactly where the east and south-east handles are — so
      // the hit test found the scrollbar and the corner could not be grabbed.
      + '<div class="bs-perf-body">'
      + `<div class="bs-perf-head">${escapeHtml(t('gfx.section.render'))}</div>`
      + '<div class="bs-perf-list"></div>'
      + `<div class="bs-perf-head">${escapeHtml(t('spawn.section'))}</div>`
      + '<input class="bs-spawn-search" type="text" spellcheck="false"'
      + ' autocomplete="off" autocapitalize="off" data-cursor="text"'
      + ` placeholder="${escapeHtml(t('spawn.search'))}">`
      // The result line sits ABOVE the tree, between the search box and the
      // rows. Under them it was correct and invisible: with a branch expanded
      // the tree is taller than the panel, so the one line telling you what the
      // click just did was always the thing scrolled off the bottom.
      + '<div class="bs-spawn-status"></div>'
      + '<div class="bs-spawn-tree"></div>'
      + '</div>'
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
    this.gfxList = this.el.querySelector('.bs-perf-list');
    this.treeEl = this.el.querySelector('.bs-spawn-tree');
    this.statusEl = this.el.querySelector('.bs-spawn-status');
    this.searchEl = this.el.querySelector('.bs-spawn-search');
    // The colour well, delegated: the well itself is replaced on every render
    // but the list it sits in is not, so one listener here outlives all of them.
    // NO RENDER on the way out — a redraw while the native picker is open
    // destroys the element the player is dragging around in.
    this.gfxList?.addEventListener('input', (e) => {
      const well = (e.target as Element | null)?.closest?.('.bs-hair-well') as HTMLInputElement | null;
      if (well) this.look.setColour(parseInt(well.value.slice(1), 16));
    });
    this.searchEl?.addEventListener('input', () => this.render());
    this.searchEl?.addEventListener('focus', () => { this.typing = true; });
    this.searchEl?.addEventListener('blur', () => { this.typing = false; });
  }

  private render(): void {
    if (!this.gfxList) this.buildShell();
    this.renderGfx();
    this.renderTree();
    if (this.statusEl) this.statusEl.textContent = this.status;
  }

  private renderGfx(): void {
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
    const timeRow = `<div class="bs-perf-row${this.cursor === ROW_TIME ? ' sel' : ''}"`
      + ' data-cursor="link-select" data-time="day">'
      + `<span class="bs-perf-name">${escapeHtml(t('gfx.timeOfDay'))}</span>`
      + `<span class="bs-perf-val">${escapeHtml(this.timeLabel())}</span>`
      + `<span class="bs-perf-cost">${escapeHtml(t('gfx.timeOfDay.cost'))}</span>`
      + '</div>';
    this.gfxList!.innerHTML = gfxRows + timeRow + this.hairRows();
  }

  /**
   * The two appearance rows, under their own heading.
   *
   * THE COLOUR WELL IS A NATIVE `<input type="color">` — the browser already
   * has a colour picker, and every alternative is a picker to draw, to place
   * and to make keyboard-reachable. It is re-created on each render like every
   * other row here, which is safe for exactly the reason the SEARCH BOX is not:
   * nothing types into it, and the one moment it must survive — while its popup
   * is open — is a moment when nothing else in the panel is being touched. The
   * live `input` events are handled without a render for that reason.
   */
  private hairRows(): string {
    const colour = this.look.colour();
    return `<div class="bs-perf-head">${escapeHtml(t('hair.section'))}</div>`
      + `<div class="bs-perf-row${this.cursor === ROW_STYLE ? ' sel' : ''}"`
      + ' data-cursor="link-select" data-hair="style">'
      + `<span class="bs-perf-name">${escapeHtml(t('hair.style'))}</span>`
      + `<span class="bs-perf-val">${escapeHtml(this.styleLabel())}</span>`
      + `<span class="bs-perf-cost">${escapeHtml(t('hair.style.cost'))}</span>`
      + '</div>'
      + `<div class="bs-perf-row${this.cursor === ROW_COLOUR ? ' sel' : ''}"`
      + ' data-cursor="link-select" data-hair="colour">'
      + `<span class="bs-perf-name">${escapeHtml(t('hair.colour'))}</span>`
      + '<span class="bs-perf-val">'
      + `<input class="bs-hair-well" type="color" data-cursor="link-select"`
      + ` value="${PerfPanel.hex(colour)}">`
      + '</span>'
      + `<span class="bs-perf-cost">${escapeHtml(t('hair.colour.cost'))}</span>`
      + '</div>';
  }

  /**
   * The tree, filtered.
   *
   * COLLAPSED UNTIL ASKED, except while there is a query — a search that made
   * you expand the branch it found the answer in would be a search that did not
   * answer. So a non-empty query forces every matching branch open and hides
   * the ones with nothing in them, and clearing it puts the manual expansion
   * back exactly as it was, because the query never wrote to `expanded`.
   */
  private renderTree(): void {
    const query = this.searchEl?.value.trim() ?? '';
    const parts: string[] = [];
    for (const b of this.catalogue.branches()) {
      const rows = query ? b.rows.filter((r) => spawnMatches(r, query)) : b.rows;
      if (query && rows.length === 0) continue;
      parts.push(this.branchHtml(b, rows, query !== '' || this.expanded.has(b.id)));
    }
    if (parts.length === 0) {
      parts.push(`<div class="bs-spawn-empty">${escapeHtml(t('spawn.noMatch'))}</div>`);
    }
    this.treeEl!.innerHTML = parts.join('');
  }

  private branchHtml(b: SpawnBranch, rows: readonly SpawnRow[], openBranch: boolean): string {
    const head = `<div class="bs-spawn-branch${openBranch ? ' open' : ''}"`
      + ` data-cursor="link-select" data-branch="${escapeHtml(b.id)}">`
      + `<span class="bs-spawn-caret">${openBranch ? '▾' : '▸'}</span>`
      + `<span class="bs-spawn-label">${escapeHtml(t(b.labelKey))}</span>`
      + `<span class="bs-spawn-count">${rows.length}</span>`
      + `<span class="bs-spawn-note">${escapeHtml(t(b.noteKey))}</span>`
      + '</div>';
    if (!openBranch) return head;
    const leaves = rows.map((r) =>
      `<div class="bs-spawn-row${r.had ? ' had' : ''}" data-cursor="link-select"`
      + ` data-branch="${escapeHtml(b.id)}" data-row="${escapeHtml(r.id)}">`
      + `<span class="bs-spawn-label">${escapeHtml(r.label)}</span>`
      // The id is shown BESIDE a display name, because that is the string
      // `/give` and `/grant` want and browsing here is how you learn it. Where
      // the two are the same string — the structure parts, which have no
      // display name at all — printing it twice is noise, so it is left out.
      + (r.label === r.id ? '' : `<span class="bs-spawn-id">${escapeHtml(r.id)}</span>`)
      + '</div>').join('');
    return head + `<div class="bs-spawn-rows">${leaves}</div>`;
  }

  /**
   * Escape leaves the field, Enter spawns the first thing on screen.
   *
   * The Enter case is the reason the search box is worth having at all: type
   * three letters, press Enter, the thing is in front of you. Everything else
   * is just passed to the field, with `stopPropagation` so the hero never sees
   * it — see the note at the top of the file.
   */
  private onSearchKey(e: KeyboardEvent): void {
    if (!this.typing) return;
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      this.blurSearch();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const first = this.treeEl?.querySelector('.bs-spawn-row[data-row]') as HTMLElement | null;
    if (!first) return;
    this.doSpawn(first.getAttribute('data-branch') ?? '', first.getAttribute('data-row') ?? '');
  }

  private blurSearch(): void {
    this.typing = false;
    this.searchEl?.blur();
  }

  private doSpawn(branchId: string, rowId: string): void {
    this.status = this.catalogue.spawn(branchId, rowId);
    this.render();
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

  /** A click on a row cycles it, expands a branch, or spawns. */
  handleClick(target: EventTarget | null, event?: MouseEvent): boolean {
    if (!this.open || !(target instanceof Element)) return false;
    // A handle or the title bar starts a drag instead of toggling anything.
    const drag = target.closest('[data-drag]') as HTMLElement | null;
    if (drag && event) {
      this.beginDrag(event, drag.getAttribute('data-drag') ?? 'move');
      return true;
    }
    // THE SEARCH FIELD FOCUSES ITSELF, and it has to. Its host claims this
    // click — `preventDefault` on the mousedown, so the canvas behind the panel
    // does not take pointer lock back the instant somebody reached for the box
    // — and a prevented mousedown is also a mousedown that never moves focus.
    // So the panel does by hand the one part of the default behaviour it wants.
    if (target.closest('.bs-spawn-search')) {
      this.searchEl?.focus();
      return true;
    }
    // ANY OTHER CLICK GIVES THE KEYBOARD BACK. Focus is what suspends the
    // hero's input (see `isTyping`), and a prevented mousedown does not move it
    // on its own — so without this, one click in the search box left the hero
    // deaf until somebody thought to press Escape, however many rows they went
    // on to click. The QUERY survives: you filter once and spawn several.
    if (this.typing) this.blurSearch();
    const leaf = target.closest('.bs-spawn-row') as HTMLElement | null;
    if (leaf) {
      this.doSpawn(leaf.getAttribute('data-branch') ?? '', leaf.getAttribute('data-row') ?? '');
      return true;
    }
    const branch = target.closest('.bs-spawn-branch') as HTMLElement | null;
    if (branch) {
      const id = branch.getAttribute('data-branch') ?? '';
      if (this.expanded.has(id)) this.expanded.delete(id);
      else this.expanded.add(id);
      this.render();
      return true;
    }
    // THE COLOUR WELL OPENS ITSELF, and it has to for the same reason the
    // search box focuses itself: the host prevents this mousedown so the canvas
    // cannot take pointer lock back, and a prevented mousedown never opens a
    // native picker either.
    const well = target.closest('.bs-hair-well') as HTMLInputElement | null;
    if (well) {
      this.cursor = ROW_COLOUR;
      well.showPicker?.();
      return true;
    }
    const row = target.closest('.bs-perf-row') as HTMLElement | null;
    if (!row) return false;
    const hair = row.getAttribute('data-hair');
    if (hair) {
      this.cursor = hair === 'style' ? ROW_STYLE : ROW_COLOUR;
      if (hair === 'style') this.cycleStyle(1);
      else this.cycleColour(1);
      this.render();
      return true;
    }
    const id = row.getAttribute('data-gfx') as keyof GfxSinks | null;
    if (!id && row.hasAttribute('data-time')) {
      this.cursor = ROW_TIME;
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
    if (!this.open) return;
    // The shell carries four translated strings of its own, so this is the one
    // path that has to rebuild it. The query is carried across by hand — a
    // language switch is not a reason to lose what somebody was searching for.
    const query = this.searchEl?.value ?? '';
    this.buildShell();
    if (this.searchEl) this.searchEl.value = query;
    this.render();
  }

  dispose(): void {
    this.el.remove();
  }
}
