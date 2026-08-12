/**
 * F3 DEBUG PANEL. NOT A MODAL — the point is watching a frame that is doing
 * real work, so the hero keeps taking input and this uses keys he ignores. The
 * search box is the exception: focused, it swallows keys in the CAPTURE phase
 * (as ui/console.ts does) and `isTyping` suspends gameplay input.
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
 * Lay a path from here (issue #142 §12). Rows here, policy in main.ts. The
 * endpoint is the hero's FACING, not the crosshair — `AIM_FAR` is 60 units and
 * roads run 72–174.
 */
export interface PathEditControl {
  readonly profiles: readonly { id: string; labelKey: StringKey }[];
  /** World units. */
  readonly lengths: readonly number[];
  profile(): string;
  setProfile(id: string): void;
  length(): number;
  setLength(n: number): void;
  crossing(): boolean;
  setCrossing(v: boolean): void;
  lay(): string;
}

/** A stand-in until the granting quests exist (game-story.md §5). */
export interface MountUnlockControl {
  /** In the order the acts hand them out; `noteKey` names the granting quest. */
  readonly kinds: readonly { id: string; labelKey: StringKey; noteKey: StringKey }[];
  has(id: string): boolean;
  set(id: string, on: boolean): void;
}

export interface AppearanceControl {
  readonly styles: readonly { id: string; labelKey: StringKey }[];
  readonly swatches: readonly number[];
  style(): string;
  setStyle(id: string): void;
  colour(): number;
  setColour(hex: number): void;
  reset(): void;
}

const ROW_TIME = GFX_OPTIONS.length;
const ROW_STYLE = ROW_TIME + 1;
const ROW_COLOUR = ROW_TIME + 2;
const ROW_PATH_PROFILE = ROW_TIME + 3;
const ROW_PATH_LENGTH = ROW_TIME + 4;
const ROW_PATH_CROSS = ROW_TIME + 5;
const ROW_PATH_LAY = ROW_TIME + 6;
/** Mounts take the LAST rows, one per kind, so a fourth moves nothing above. */
const ROW_MOUNT = ROW_TIME + 7;
const EXTRA_ROWS = 7;

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

export class PerfPanel {
  private readonly el: HTMLDivElement;
  private open = false;
  private cursor = 0;
  /** Only these are re-generated: a whole-panel `innerHTML` kills the caret. */
  private gfxList: HTMLDivElement | null = null;
  private treeEl: HTMLDivElement | null = null;
  private statusEl: HTMLDivElement | null = null;
  private searchEl: HTMLInputElement | null = null;
  private expanded = new Set<string>();
  private status = '';
  private typing = false;

  constructor(
    private readonly gfx: Gfx,
    private readonly time: TimeOfDayControl,
    private readonly catalogue: SpawnCatalogue,
    private readonly look: AppearanceControl,
    private readonly paths: PathEditControl,
    private readonly mounts: MountUnlockControl,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'bs-perf';
    this.el.style.display = 'none';
    document.body.appendChild(this.el);
    // Capture phase, ahead of core/input.ts, so a typed letter does not strafe.
    window.addEventListener('keydown', (e) => this.onSearchKey(e), true);
    // `Input` spends every wheel notch on camera zoom, so a scroll over the
    // panel walked the lens. `stopPropagation` only — the browser still scrolls.
    window.addEventListener('wheel', (e) => {
      if (!this.open || !(e.target instanceof Node) || !this.el.contains(e.target)) return;
      e.stopPropagation();
    }, true);
  }

  get isOpen(): boolean { return this.open; }

  /** main.ts folds this into `modal`: it suspends input, not the clock (#101). */
  get isTyping(): boolean { return this.typing; }

  toggle(): void {
    this.open = !this.open;
    // `flex`, NOT `block` — inline `block` beats the stylesheet's column and the
    // body stops shrinking, so the panel grows past the bottom of the window.
    this.el.style.display = this.open ? 'flex' : 'none';
    if (this.open) {
      this.buildShell();
      this.render();
    } else {
      this.blurSearch();
    }
  }

  /** Returns whether the key was ours, so a future hero binding cannot collide. */
  onKey(code: string): boolean {
    if (!this.open) return false;
    const n = this.rowCount;
    if (code === 'ArrowDown') { this.cursor = (this.cursor + 1) % n; this.render(); return true; }
    if (code === 'ArrowUp') { this.cursor = (this.cursor + n - 1) % n; this.render(); return true; }
    if (code === 'ArrowRight' || code === 'ArrowLeft' || code === 'Enter' || code === 'Space') {
      const step = code === 'ArrowLeft' ? -1 : 1;
      if (this.cursor === ROW_TIME) this.cycleTime(step);
      else if (this.cursor === ROW_STYLE) this.cycleStyle(step);
      else if (this.cursor === ROW_COLOUR) this.cycleColour(step);
      else if (this.cursor >= ROW_MOUNT) this.flipMount(this.cursor - ROW_MOUNT);
      else if (this.cursor >= ROW_PATH_PROFILE) this.cyclePath(this.cursor, step);
      else this.gfx.cycle(GFX_OPTIONS[this.cursor].id);
      this.render();
      return true;
    }
    if (code === 'KeyR') {
      this.gfx.reset();
      this.time.set(null);
      this.look.reset();
      // NOT the mount rows: R resets views, never progress an autosave keeps.
      this.render();
      return true;
    }
    return false;
  }

  /** Also called after a console `/gfx`. */
  refresh(): void {
    if (this.open) this.render();
  }

  /** Derived, so a fourth mount kind is arrow-reachable with no edit here. */
  private get rowCount(): number {
    return GFX_OPTIONS.length + EXTRA_ROWS + this.mounts.kinds.length;
  }

  private flipMount(i: number): void {
    const kind = this.mounts.kinds[i];
    if (kind) this.mounts.set(kind.id, !this.mounts.has(kind.id));
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

  /** A colour off the strip (picked from the well) resumes at the nearest one. */
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

  /** Rebuilt on open and on a language switch only — see `gfxList` above. */
  private buildShell(): void {
    this.el.innerHTML =
      '<div class="bs-perf-title" data-cursor="grab" data-drag="move">'
      + `${escapeHtml(t('gfx.title'))}</div>`
      // The rows scroll, the panel does not: `overflow` here clips the resize
      // handles and its scrollbar steals the e/se hit test.
      + '<div class="bs-perf-body">'
      + `<div class="bs-perf-head">${escapeHtml(t('gfx.section.render'))}</div>`
      + '<div class="bs-perf-list"></div>'
      + `<div class="bs-perf-head">${escapeHtml(t('spawn.section'))}</div>`
      + '<input class="bs-spawn-search" type="text" spellcheck="false"'
      + ' autocomplete="off" autocapitalize="off" data-cursor="text"'
      + ` placeholder="${escapeHtml(t('spawn.search'))}">`
      // ABOVE the tree: under it, an expanded branch scrolls the line off.
      + '<div class="bs-spawn-status"></div>'
      + '<div class="bs-spawn-tree"></div>'
      + '</div>'
      + `<div class="bs-perf-hint">${escapeHtml(t('gfx.hint'))}</div>`
      // Each handle names its own cursor; a diagonal must match its corner.
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
    // Delegated: the well is replaced each render, the list is not. And NO
    // render out of here — a redraw destroys the open native picker.
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
        // Explicit `data-cursor`: ui/cursor.ts reads BUTTON and [data-act] only.
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
    this.gfxList!.innerHTML = gfxRows + timeRow + this.hairRows() + this.pathRows()
      + this.mountRows();
  }

  /** The native colour well is safe to re-create: nothing types into it. */
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

  private cyclePath(row: number, step: number): void {
    if (row === ROW_PATH_PROFILE) {
      const list = this.paths.profiles;
      const i = Math.max(0, list.findIndex((o) => o.id === this.paths.profile()));
      this.paths.setProfile(list[(i + step + list.length) % list.length].id);
    } else if (row === ROW_PATH_LENGTH) {
      const list = this.paths.lengths;
      const i = Math.max(0, list.indexOf(this.paths.length()));
      this.paths.setLength(list[(i + step + list.length) % list.length]);
    } else if (row === ROW_PATH_CROSS) {
      this.paths.setCrossing(!this.paths.crossing());
    } else {
      // The action row: it costs a full chunk rebuild, so it is last.
      this.status = this.paths.lay();
    }
  }

  /** No text field: a focused one sets `isTyping` and suspends the hero. */
  private pathRows(): string {
    const profile = this.paths.profiles.find((o) => o.id === this.paths.profile());
    const row = (cursor: number, key: string, name: string, val: string, cost: string): string =>
      `<div class="bs-perf-row${this.cursor === cursor ? ' sel' : ''}"`
      + ` data-cursor="link-select" data-path="${key}">`
      + `<span class="bs-perf-name">${escapeHtml(name)}</span>`
      + `<span class="bs-perf-val">${escapeHtml(val)}</span>`
      + `<span class="bs-perf-cost">${escapeHtml(cost)}</span>`
      + '</div>';
    return `<div class="bs-perf-head">${escapeHtml(t('path.section'))}</div>`
      + row(ROW_PATH_PROFILE, 'profile', t('path.profile'),
        profile ? t(profile.labelKey) : this.paths.profile(), t('path.profile.cost'))
      + row(ROW_PATH_LENGTH, 'length', t('path.length'),
        `${this.paths.length()}`, t('path.length.cost'))
      + row(ROW_PATH_CROSS, 'cross', t('path.crossing'),
        t(this.paths.crossing() ? 'path.crossing.merge' : 'path.crossing.avoid'),
        t('path.crossing.cost'))
      + row(ROW_PATH_LAY, 'lay', t('path.lay'), t('path.lay.go'), t('path.lay.cost'));
  }

  /** The cost column names the granting quest instead (game-story.md §5). */
  private mountRows(): string {
    return `<div class="bs-perf-head">${escapeHtml(t('mount.section'))}</div>`
      + this.mounts.kinds.map((k, i) => {
        const on = this.mounts.has(k.id);
        return `<div class="bs-perf-row${this.cursor === ROW_MOUNT + i ? ' sel' : ''}`
          + `${on ? '' : ' off'}" data-cursor="link-select" data-mount="${escapeHtml(k.id)}">`
          + `<span class="bs-perf-name">${escapeHtml(t(k.labelKey))}</span>`
          + `<span class="bs-perf-val">${escapeHtml(t(on ? 'gfx.on' : 'gfx.off'))}</span>`
          + `<span class="bs-perf-cost">${escapeHtml(t(k.noteKey))}</span>`
          + '</div>';
      }).join('');
  }

  /** A query never writes `expanded`, so clearing it restores manual state. */
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
      // The id is what `/give` wants; skipped when it equals the label.
      + (r.label === r.id ? '' : `<span class="bs-spawn-id">${escapeHtml(r.id)}</span>`)
      + '</div>').join('');
    return head + `<div class="bs-spawn-rows">${leaves}</div>`;
  }

  /** Everything but Escape/Enter falls through, stopped so the hero misses it. */
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

  /** Tracked on WINDOW: a fast drag outruns the handle's own listener. */
  private beginDrag(e: MouseEvent, mode: string): void {
    const r = this.el.getBoundingClientRect();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const start = { left: r.left, top: r.top, w: r.width, h: r.height };
    // Pin the cursor: the pointer leaves the 6px handle almost immediately.
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

  /** Clamped off-screen. Min width fits the longest cost string; min height
   * keeps the title grabbable. */
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

  handleClick(target: EventTarget | null, event?: MouseEvent): boolean {
    if (!this.open || !(target instanceof Element)) return false;
    const drag = target.closest('[data-drag]') as HTMLElement | null;
    if (drag && event) {
      this.beginDrag(event, drag.getAttribute('data-drag') ?? 'move');
      return true;
    }
    // Focused by hand: the host prevents this mousedown (so the canvas cannot
    // retake pointer lock), and a prevented mousedown never moves focus.
    if (target.closest('.bs-spawn-search')) {
      this.searchEl?.focus();
      return true;
    }
    // A prevented mousedown will not move focus off the field on its own.
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
    // Opened by hand, for the same reason the search box is focused by hand.
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
    const mount = row.getAttribute('data-mount');
    if (mount) {
      const i = this.mounts.kinds.findIndex((k) => k.id === mount);
      if (i < 0) return false;
      this.cursor = ROW_MOUNT + i;
      this.flipMount(i);
      this.render();
      return true;
    }
    const path = row.getAttribute('data-path');
    if (path) {
      this.cursor = path === 'profile' ? ROW_PATH_PROFILE
        : path === 'length' ? ROW_PATH_LENGTH
          : path === 'cross' ? ROW_PATH_CROSS : ROW_PATH_LAY;
      this.cyclePath(this.cursor, 1);
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

  /** Same contract as HUD.relabel. */
  relabel(): void {
    if (!this.open) return;
    // The shell holds translated strings, so rebuild it and carry the query.
    const query = this.searchEl?.value ?? '';
    this.buildShell();
    if (this.searchEl) this.searchEl.value = query;
    this.render();
  }

  dispose(): void {
    this.el.remove();
  }
}
