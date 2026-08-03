/**
 * THE IN-GAME CURSOR — sixteen states cut out of one sprite sheet at boot and
 * handed to the browser as ordinary CSS cursors.
 *
 * WHY CSS AND NOT A DIV THAT FOLLOWS THE MOUSE. The obvious build is an
 * absolutely-positioned element moved on `mousemove`, and it is wrong for the
 * one thing a cursor has to do: a DOM cursor is composited a frame late, so at
 * 120 fps it trails the real pointer by 8 ms and every click feels like it
 * landed slightly behind where you aimed. A CSS cursor is drawn by the
 * COMPOSITOR against the OS pointer position and cannot lag. It also keeps
 * working while the main thread is busy building a chunk, which is exactly when
 * a player is most likely to be reaching for the F3 panel.
 *
 * WHY ONE SHEET AND NOT SIXTEEN FILES. `cursor: url(...)` needs one image per
 * state, so the sheet is sliced into sixteen data URIs — once, at boot, on a
 * canvas — rather than shipping sixteen assets. The source art is 1254x1254 and
 * 1.06 MB; repacked to 64px tiles it is 23.5 KB, which is the difference
 * between an asset and a nuisance.
 *
 * THE ASSET RULE. AGENTS.md says no asset files and names a sprite sheet
 * specifically. This is the second exception after the title-screen poster and
 * it was taken deliberately (issue #38): a cursor is 2D chrome the renderer
 * never touches, the art is the design, and sixteen hand-drawn fantasy pointers
 * are not something to reproduce in code. Everything the RENDERER draws is
 * still generated. Imported, not dropped in a `public/` folder, for the reason
 * spelled out on the menu art — `base:'./'` builds have to work from any
 * subfolder and Vite rewrites an import's URL for you.
 *
 * SIZE. Browsers cap a custom cursor at 128x128 (Chrome) and quietly fall back
 * to the default past it, so 64 is a deliberate ceiling rather than a taste:
 * big enough to read as art on a high-DPI screen, small enough that no browser
 * refuses it.
 */
import sheetUrl from './cursors.webp';

/**
 * The sixteen states, in the sheet's own reading order — left to right, top to
 * bottom, so the index into this array IS the tile index. Issue #38 defines the
 * order and the meanings; keep them in step.
 */
export const CURSOR_STATES = [
  'default', 'link-select', 'pressed', 'text-select',
  'grab', 'grabbing', 'move', 'resize-horizontal',
  'resize-vertical', 'resize-nwse', 'resize-nesw', 'forbidden',
  'busy', 'help', 'inspect', 'attack-target',
] as const;
export type CursorState = (typeof CURSOR_STATES)[number];

/** Tile size in the repacked sheet. See the note on the browser's 128px cap. */
const TILE = 64;

/**
 * Where the click actually happens, per state, in tile pixels.
 *
 * MEASURED off the art rather than guessed: the packer reported each tile's
 * opaque bounding box, and these are read from those. Two rules, and the split
 * matters more than any single number — a cursor whose hotspot is in the wrong
 * place is worse than no custom cursor at all, because the player aims with the
 * picture and the game answers somewhere else.
 *
 *   POINTERS point. The arrow, the finger and the pressed finger all act at
 *   their TIP, which is the top-left of their ink (boxes 21,17 / 16,17 / 7,10
 *   — the pressed one's box starts further out only because its impact rays
 *   stick up and to the left of the fingertip, so its hotspot is pulled back
 *   in rather than taken from the box corner).
 *
 *   EVERYTHING ELSE IS SYMMETRIC and acts at its CENTRE: the I-beam, the four
 *   resize arrows, the move star, the forbidden disc, the reticle. Every one of
 *   those is drawn around a red gem that sits on the centre of the glyph, which
 *   is a gift from the artist — the gem IS the hotspot.
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

/**
 * A ready-to-assign CSS value per state, built once.
 *
 * The `, auto` tail is not decoration: a browser that refuses the image — too
 * large, decode failed, a headless run with no cursor at all — falls back to
 * the system pointer instead of showing nothing, and the UI stays usable.
 */
export class Cursors {
  private css = new Map<CursorState, string>();
  private current: CursorState | null = null;
  private el: HTMLElement = document.body;
  private ready = false;

  /**
   * Slice the sheet. Async because an Image decode is, and everything degrades
   * to the system cursor until it resolves — there is no frame where the UI is
   * unusable, only frames where it is ordinary.
   */
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
    // Whatever was asked for while the sheet was decoding, now for real.
    if (this.current) {
      const want = this.current;
      this.current = null;
      this.set(want);
    }
  }

  /**
   * Show one state. Cheap to call every mousemove — it early-outs unless the
   * state actually changed, because assigning `style.cursor` invalidates the
   * cursor even when the string is identical and some browsers flicker on it.
   */
  set(state: CursorState): void {
    if (this.current === state) return;
    this.current = state;
    if (!this.ready) return;
    this.el.style.cursor = this.css.get(state) ?? 'auto';
  }

  /** Hide it entirely — for pointer lock, where there is no pointer to draw. */
  hide(): void {
    this.current = null;
    this.el.style.cursor = 'none';
  }

  /** Hand the cursor back to the system, e.g. on dispose. */
  clear(): void {
    this.current = null;
    this.el.style.cursor = '';
  }

  /** For tools/test-cursor.mjs: what is showing, and did the art load. */
  debug(): { state: CursorState | null; ready: boolean; states: number } {
    return { state: this.current, ready: this.ready, states: this.css.size };
  }
}

/**
 * WHAT THE CURSOR SHOULD BE, RIGHT NOW.
 *
 * Two sources, and the split is the whole design. Anything the player is
 * pointing AT IN THE DOM answers for itself — a button knows it is clickable, a
 * disabled row knows it is not, and neither wants a central registry of
 * selectors that goes stale the day somebody adds a panel. Anything over the
 * CANVAS is the world's business, and the world is asked through one callback
 * so this file never learns what an enemy is.
 *
 * DOM elements declare a state with `data-cursor`, and the walk goes UP from the
 * hit element, so a wrapper can speak for its children. Where nothing declares
 * anything the tag decides, which is what keeps existing UI working without
 * being touched: a `<button>` is clickable, a disabled one is forbidden, an
 * `<input>` takes text.
 */
export interface CursorWorld {
  /**
   * The state for a point over the canvas, in CSS pixels, or null for the
   * default. main.ts implements this against the enemy and NPC lists.
   */
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
    // CAPTURE phase, and for the same reason core/input.ts listens for touch
    // there: the panels call stopPropagation on their own presses, so a bubble
    // listener would never see a click that landed on a control — which is
    // precisely the click that should show the pressed state.
    window.addEventListener('mousedown', () => { this.held = true; this.refresh(); }, true);
    window.addEventListener('mouseup', () => { this.held = false; this.refresh(); }, true);
  }

  /** Turn the whole thing on or off — off means pointer lock owns the mouse. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) this.refresh();
    else this.cursors.hide();
  }

  /**
   * Pin a state for the duration of a drag, or release it with null.
   *
   * A drag has to survive the pointer leaving the thing being dragged — you
   * grab a panel edge and pull, and half a second later the mouse is over the
   * sky. Without this the cursor would snap back to `default` mid-resize and
   * the interaction would look broken while working perfectly.
   */
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

    // The loading cover is busy whatever is under it.
    if (document.querySelector('.bs-load.cover.show')) return 'busy';

    const declared = this.fromDom(el);
    if (declared) return this.held && declared === 'link-select' ? 'pressed' : declared;

    // Over the canvas: ask the world. It is the only caller that can tell an
    // enemy from a tree, and it answers in the same vocabulary.
    if (el instanceof HTMLCanvasElement) return this.world.at(this.lastX, this.lastY) ?? 'default';
    return 'default';
  }

  /** Walk up from the hit element until something claims a state. */
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
