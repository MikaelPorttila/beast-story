/**
 * THE IN-GAME CURSOR (issue #38) — sixteen states sliced out of one sprite sheet at
 * boot and handed over as CSS cursors, which the compositor draws against the OS
 * pointer so they cannot lag. 64px tiles because Chrome refuses past 128x128.
 * Imported, not in `public/`, for the `base:'./'` reason on the menu art.
 */
import sheetUrl from './cursors.webp';

/** Sheet reading order — the index here IS the tile index. */
export const CURSOR_STATES = [
  'default', 'link-select', 'pressed', 'text-select',
  'grab', 'grabbing', 'move', 'resize-horizontal',
  'resize-vertical', 'resize-nwse', 'resize-nesw', 'forbidden',
  'busy', 'help', 'inspect', 'attack-target',
] as const;
export type CursorState = (typeof CURSOR_STATES)[number];

const TILE = 64;

/**
 * Click points, measured off the art's opaque bounding boxes. Pointers act at
 * their TIP; symmetric glyphs act at their CENTRE.
 */
const HOTSPOTS: Record<CursorState, readonly [number, number]> = {
  'default': [22, 18],
  'link-select': [24, 18],
  'pressed': [30, 26],
  'text-select': [27, 41],
  'grab': [32, 35],
  'grabbing': [30, 38],
  'move': [28, 29],
  'resize-horizontal': [26, 36],
  'resize-vertical': [32, 30],
  'resize-nwse': [30, 31],
  'resize-nesw': [28, 31],
  'forbidden': [25, 32],
  'busy': [33, 26],
  'help': [29, 26],
  'inspect': [24, 22],
  'attack-target': [25, 25],
};

/** The `, auto` tail matters: a refused image falls back to the system pointer. */
export class Cursors {
  private css = new Map<CursorState, string>();
  private current: CursorState | null = null;
  private el: HTMLElement = document.body;
  private ready = false;

  /** Slice the sheet. Degrades to the system cursor until it resolves. */
  async load(): Promise<void> {
    const img = new Image();
    img.src = sheetUrl;
    try {
      await img.decode();
    } catch {
      return;   // no sheet: every set() below stays on the system cursor
    }
    const c = document.createElement('canvas');
    c.width = TILE;
    c.height = TILE;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    for (let i = 0; i < CURSOR_STATES.length; i++) {
      const state = CURSOR_STATES[i];
      ctx.clearRect(0, 0, TILE, TILE);
      ctx.drawImage(img, (i % 4) * TILE, Math.floor(i / 4) * TILE, TILE, TILE, 0, 0, TILE, TILE);
      const [hx, hy] = HOTSPOTS[state];
      this.css.set(state, `url(${c.toDataURL('image/png')}) ${hx} ${hy}, auto`);
    }
    this.ready = true;
    if (this.current) {
      const want = this.current;
      this.current = null;
      this.set(want);
    }
  }

  /** Show one state. Early-outs: re-assigning `style.cursor` flickers in some browsers. */
  set(state: CursorState): void {
    if (this.current === state) return;
    this.current = state;
    if (!this.ready) return;
    this.el.style.cursor = this.css.get(state) ?? 'auto';
  }

  /** Hide it entirely, for pointer lock. */
  hide(): void {
    this.current = null;
    this.el.style.cursor = 'none';
  }

  /** The HUD's own `cursor:pointer` beats inheritance, so `.bs-cursor` overrides it. */
  enable(on: boolean): void {
    document.body.classList.toggle('bs-cursor', on);
    if (!on) this.clear();
  }

  /** Hand the cursor back to the system. */
  clear(): void {
    this.current = null;
    this.el.style.cursor = '';
  }

  /** For tools/test-cursor.mjs. */
  debug(): { state: CursorState | null; ready: boolean; states: number } {
    return { state: this.current, ready: this.ready, states: this.css.size };
  }
}

/**
 * Two sources: DOM elements answer via `data-cursor` (the walk goes UP) or their
 * tag; anything over the CANVAS is asked of the world.
 */
export interface CursorWorld {
  /** State for a canvas point in CSS pixels, or null. main.ts implements it. */
  at(x: number, y: number): CursorState | null;
}

export class CursorDirector {
  private held = false;
  private lastX = 0;
  private lastY = 0;
  /** Set while a drag owns the cursor — see `lock`. */
  private forced: CursorState | null = null;
  private enabled = false;

  constructor(
    private readonly cursors: Cursors,
    private readonly world: CursorWorld,
  ) {
    window.addEventListener('mousemove', (e) => {
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.refresh();
    });
    // CAPTURE phase: panels stopPropagation their own presses.
    window.addEventListener('mousedown', () => { this.held = true; this.refresh(); }, true);
    window.addEventListener('mouseup', () => { this.held = false; this.refresh(); }, true);
  }

  /** Off means pointer lock owns the mouse. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    this.cursors.enable(on);
    if (on) this.refresh();
  }

  /** Pin a state for a drag, or release with null — a drag outlives its target. */
  lock(state: CursorState | null): void {
    this.forced = state;
    this.refresh();
  }

  refresh(): void {
    if (!this.enabled) return;
    this.cursors.set(this.forced ?? this.resolve());
  }

  private resolve(): CursorState {
    const el = document.elementFromPoint(this.lastX, this.lastY);
    if (!el) return 'default';

    if (document.querySelector('.bs-load.cover.show')) return 'busy';

    const declared = this.fromDom(el);
    if (declared) return this.held && declared === 'link-select' ? 'pressed' : declared;

    if (el instanceof HTMLCanvasElement) return this.world.at(this.lastX, this.lastY) ?? 'default';
    return 'default';
  }

  /** Walk up until something claims a state. */
  private fromDom(start: Element): CursorState | null {
    for (let el: Element | null = start; el && el !== document.body; el = el.parentElement) {
      const attr = el.getAttribute('data-cursor');
      if (attr && (CURSOR_STATES as readonly string[]).includes(attr)) return attr as CursorState;
      if (el.hasAttribute('disabled') || el.classList.contains('disabled')) return 'forbidden';
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return 'text-select';
      if (tag === 'BUTTON' || el.hasAttribute('data-act')) return 'link-select';
    }
    return null;
  }
}
