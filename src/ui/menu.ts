import { isTouchPrimary } from '../core/touch';
import { loadPrefs, savePrefs, type Prefs } from '../core/prefs';
import { flags } from '../core/flags';
import { t, language, languages, setLanguage, onLanguageChange } from '../i18n';
import type { LookAxes } from '../core/gamepad';
import { FullscreenPrompt } from './fullscreen';
import { injectStyles } from './styles';

/**
 * The title screen — splash, "Press start...", then New Game / Load / Settings.
 *
 * WHAT IT IS MADE OF
 *
 * Two pictures and CSS. `public/menu-bg.webp` and `public/menu-logo.webp` are
 * the only art files in the whole project, and they are a deliberate exception
 * to the "everything is generated in code" rule that governs the game itself:
 * this is a 2D poster, not a thing the renderer has to build, and a painted
 * splash is the one place where an image IS the design. Everything moving on
 * top of them — the lantern pulse, the fairies, the logo's slide — is CSS
 * animation, so the menu costs no JavaScript per frame. The only per-frame work
 * while it is up is the gamepad poll below, and that only runs if the page can
 * see a pad at all.
 *
 * WHY THE ART IS INSIDE A SIZED PLATE
 *
 * The glows have to sit ON the lanterns in the painting, and the painting is
 * cover-cropped to whatever shape the window is. So `.plate` reproduces
 * `background-size:cover` in explicit numbers — `max(100vw, 100dvh * AR)` by
 * `max(100dvh, 100vw / AR)` — and the image plus every glow live inside it as
 * PERCENTAGES. The lamp coordinates below were read off the source pixels, and
 * because they are relative to the plate rather than to the viewport they stay
 * nailed to the lanterns at any aspect ratio, including the crop where a lamp
 * is off screen entirely.
 *
 * THE STEPS
 *
 *   press  -> fullscreen (touch only) -> options -> settings -> options
 *
 * `fullscreen` is a step rather than the free-floating pill the game used to
 * raise on its first frame: on a phone the answer decides how the whole session
 * is framed, so it is asked once, deliberately, between pressing start and
 * choosing anything. It is ALWAYS asked there — see `askedFullscreen`.
 *
 * INPUT. Keyboard, pointer and pad all work, and the options are real
 * `<button>`s so Enter/Space, tab order and focus rings come from the platform
 * rather than from a bespoke widget. Arrow keys and the pad's d-pad move the
 * focus; the pad's poll is the only thing here that runs per frame.
 */

/** Where the source art's lanterns are, in per-cent of the picture. */
interface Lamp {
  /** Centre of the glow, as a fraction of the picture's width/height. */
  x: number;
  y: number;
  /** Glow diameter as a fraction of the picture's width. */
  r: number;
  /** Seconds per pulse. Deliberately co-prime-ish so the three never sync up. */
  period: number;
}

/**
 * Measured off `public/menu-bg.webp` (1672x941) by zooming on each lantern and
 * reading the centre of its glass: left post 84,670 — gate post 609,728 — right
 * post 1579,677. Written as fractions so they survive the day someone re-exports
 * the art at another size, as long as the framing is the same.
 *
 * Three different periods rather than one shared clock. Lanterns pulsing in
 * lockstep read as a single global brightness animation — a fade on the whole
 * picture — where staggered ones read as three separate flames.
 */
const LAMPS: ReadonlyArray<Lamp> = [
  { x: 84 / 1672, y: 670 / 941, r: 0.115, period: 4.3 },
  { x: 609 / 1672, y: 728 / 941, r: 0.065, period: 3.1 },
  { x: 1579 / 1672, y: 677 / 941, r: 0.115, period: 5.2 },
];

/**
 * The fairies, one entry per sprite.
 *
 * Hand-placed rather than randomised, for the same reason the capture tools pin
 * `photo=1`: a title screen that is different every load cannot be compared
 * against yesterday's screenshot. Each crosses the frame on its own clock, and
 * `delay` is NEGATIVE so the animation starts part-way through — otherwise
 * every fairy enters from the same edge in the first second and the screen
 * looks empty before that.
 *
 * `top` keeps them in the upper two thirds, over sky and canopy, because the
 * bottom third is flowers and the hero: a glowing dot down there reads as a
 * missing sprite rather than as a fairy.
 */
interface Fairy {
  top: number;      // per cent of viewport height
  size: number;     // px at 1080p, scaled by the sprite's own glow
  duration: number; // seconds to cross
  delay: number;    // negative: start mid-flight
  bob: number;      // seconds per vertical wobble
  bobY: number;     // px of wobble
  reverse: boolean; // right-to-left
  hue: 'warm' | 'cool';
}

/**
 * SIZES ARE NOT SUBTLE, and the first pass proved why. At 4-8px with a soft
 * amber halo they were invisible against the painting's bright noon sky — a
 * capture at 1920x1080 showed empty air where all seven were sitting. The art
 * is daylight, not dusk, so a fairy has to out-brighten a lit cloud to read at
 * all: 8-15px with a white core and a halo two and a half times its own width.
 * Over the canopy and the fence they are unmistakable; over the brightest
 * cloud they are still a soft firefly, which is the right floor.
 */
const FAIRIES: ReadonlyArray<Fairy> = [
  { top: 18, size: 12, duration: 26, delay: -3, bob: 3.1, bobY: 26, reverse: false, hue: 'warm' },
  { top: 34, size: 9, duration: 34, delay: -19, bob: 4.2, bobY: 18, reverse: true, hue: 'cool' },
  { top: 52, size: 15, duration: 21, delay: -11, bob: 2.7, bobY: 32, reverse: false, hue: 'warm' },
  { top: 27, size: 8, duration: 41, delay: -30, bob: 5.1, bobY: 14, reverse: true, hue: 'warm' },
  { top: 63, size: 11, duration: 29, delay: -7, bob: 3.6, bobY: 22, reverse: false, hue: 'cool' },
  { top: 44, size: 9, duration: 37, delay: -24, bob: 4.7, bobY: 16, reverse: true, hue: 'warm' },
  { top: 11, size: 10, duration: 31, delay: -15, bob: 3.3, bobY: 20, reverse: false, hue: 'cool' },
];

type Step = 'press' | 'fullscreen' | 'options' | 'settings';

export interface StartMenuHooks {
  /**
   * New Game. Fired once, after the menu has faded out and taken itself off the
   * DOM — the game gets a clear screen, not a fade it has to render behind.
   */
  onStart: () => void;
  /**
   * The exit fade has STARTED, which is the moment the game behind the poster
   * becomes visible again — half a second before `onStart`.
   *
   * It exists because the two facts are different: `onStart` means "the player
   * is now playing", this one means "what you draw is now being seen". Anything
   * the caller stood down while the screen was covered has to come back here,
   * not there, or the dissolve is the one janky moment in the whole sequence.
   */
  onLeave?: () => void;
  /**
   * A look-axis toggle moved. Applied LIVE rather than on close: the pad is
   * already connected while the menu is up, and someone flipping "invert Y" is
   * about to test it. Persisting is this module's job, not the caller's.
   */
  onLookAxes: (a: Partial<LookAxes>) => void;
}

/** `?menu=` — 0 suppresses the menu, 1 forces it into a staged capture. */
function menuParam(): '0' | '1' | null {
  try {
    const v = new URLSearchParams(window.location.search).get('menu');
    return v === '0' || v === '1' ? v : null;
  } catch {
    return null;
  }
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

export class StartMenu {
  private el: HTMLDivElement | null = null;
  private step: Step = 'press';
  private prefs: Prefs;
  private unlisten: (() => void) | null = null;
  private padRaf = 0;
  /** Buttons of whichever panel is showing, in focus order. */
  private focusables: HTMLButtonElement[] = [];
  private focusIdx = 0;
  /** Selector for the button the NEXT panel build should focus. See renderPanel. */
  private pendingFocus: string | null = null;
  /** Edge detection for the pad poll: held last frame, and went down this one. */
  private padDown = new Uint8Array(20);
  private padEdge = new Uint8Array(20);
  private padAxisLatched = false;
  private fsPrompt: FullscreenPrompt | null = null;

  /**
   * Build the menu, or return null when the game should just start.
   *
   * The gate, in order:
   *   - `?menu=0` suppresses it outright. Every probe in `tools/` passes this,
   *     because they drive the hero and a title screen in front of him would
   *     make each of them measure a menu instead.
   *   - `?menu=1` forces it, INCLUDING in photo mode, which is how a still of
   *     the title screen gets captured. In photo mode every animation on it is
   *     paused (see the `photo` class) so two captures match.
   *   - otherwise: shown, unless `photo=1` — a staged capture of the world must
   *     not have a poster in front of it.
   */
  static offer(hooks: StartMenuHooks): StartMenu | null {
    const p = menuParam();
    if (p === '0') return null;
    if (p !== '1' && flags.photo) return null;
    return new StartMenu(hooks, p === '1' && flags.photo);
  }

  private constructor(private hooks: StartMenuHooks, private frozen: boolean) {
    injectStyles();
    this.prefs = loadPrefs();

    const el = document.createElement('div');
    el.className = `bs-menu${this.frozen ? ' photo' : ''}`;
    el.setAttribute('data-step', 'press');
    el.innerHTML = this.markup();
    this.el = el;
    document.body.appendChild(el);

    // The whole panel is rebuilt when the language changes, which is the one
    // thing in the game that can happen WHILE this is on screen — the picker is
    // three lines below. Rebuilding rather than relabelling because the panel is
    // markup composed per step, not a fixed set of captions.
    this.unlisten = onLanguageChange(() => {
      // The player is standing ON the chip they just pressed, so the rebuild has
      // to give it back — otherwise picking a language throws the cursor to the
      // top of the settings list, which on a pad is the cursor disappearing.
      this.pendingFocus = `[data-lang="${language()}"]`;
      this.renderPanel();
    });

    el.addEventListener('click', this.onClick);
    window.addEventListener('keydown', this.onKeyDown, true);
    this.renderPanel();
    this.pollPad();

    // Next frame so the entrance transition has a start state to move from —
    // the same one-frame delay ui/fullscreen.ts uses for its pill.
    requestAnimationFrame(() => el.classList.add('show'));
  }

  get isOpen(): boolean {
    return this.el !== null;
  }

  /** Which step is showing. Read by tools/test-menu.mjs; not used internally. */
  get currentStep(): Step {
    return this.step;
  }

  // -------------------------------------------------------------------------
  // Markup
  // -------------------------------------------------------------------------

  /**
   * A public/ asset's URL, resolved against the DOCUMENT rather than the site
   * root.
   *
   * `vite.config.ts` sets `base:'./'` so a build can be served from any
   * subfolder (that is what `bun run snapshot` produces), and a root-absolute
   * `/menu-bg.webp` would 404 in exactly that case. Vite does not rewrite string
   * literals in JS, so the relative resolve has to happen here: against
   * `document.baseURI` it yields `/menu-bg.webp` on the dev server and
   * `/2026-08-01_1030/menu-bg.webp` inside a snapshot, with no build step
   * involved either time.
   */
  private asset(name: string): string {
    return new URL(name, document.baseURI).href;
  }

  private markup(): string {
    const lamps = LAMPS.map((l) =>
      `<i class="lamp" style="--x:${(l.x * 100).toFixed(2)}%;--y:${(l.y * 100).toFixed(2)}%;` +
      `--r:${(l.r * 100).toFixed(2)}%;--p:${l.period}s"></i>`).join('');

    const fairies = FAIRIES.map((f) =>
      `<i class="fly${f.reverse ? ' rev' : ''} ${f.hue}" style="--top:${f.top}%;--sz:${f.size}px;` +
      `--dur:${f.duration}s;--delay:${f.delay}s;--bob:${f.bob}s;--bobY:${f.bobY}px"><b></b></i>`).join('');

    return (
      '<div class="stage">' +
        '<div class="plate">' +
          `<img class="art" src="${this.asset('menu-bg.webp')}" alt="" draggable="false">` +
          lamps +
        '</div>' +
        `<div class="flies">${fairies}</div>` +
        '<div class="vign"></div>' +
      '</div>' +
      '<div class="fore">' +
        `<img class="logo" src="${this.asset('menu-logo.webp')}" ` +
        `alt="${escapeHtml(t('menu.title'))}" draggable="false">` +
        '<div class="panel"></div>' +
      '</div>'
    );
  }

  /**
   * Rebuild the panel under the logo for the current step.
   *
   * One method for all four steps because they are one element: what changes
   * between them is a few buttons, and swapping the innerHTML of a single node
   * keeps the logo — the thing that has to slide smoothly — untouched by the
   * change. A rebuilt panel means rebuilt buttons, so `focusables` is refreshed
   * here too and nowhere else.
   */
  private renderPanel(): void {
    const el = this.el;
    if (!el) return;
    const panel = el.querySelector('.panel') as HTMLDivElement;
    const logo = el.querySelector('.logo') as HTMLImageElement | null;
    if (logo) logo.alt = t('menu.title');
    el.setAttribute('data-step', this.step);

    if (this.step === 'press') {
      panel.innerHTML = `<div class="press">${escapeHtml(t('menu.pressStart'))}</div>`;
    } else if (this.step === 'fullscreen') {
      // The pill builds and owns itself, exactly as it does in game; the panel
      // stays empty so the logo is not sitting on top of two competing asks.
      panel.innerHTML = '';
    } else if (this.step === 'options') {
      panel.innerHTML =
        '<div class="opts">' +
          this.btn('new', t('menu.newGame'), 'primary') +
          this.btn('load', t('menu.load'), 'disabled') +
          `<div class="note">${escapeHtml(t('menu.load.unavailable'))}</div>` +
          this.btn('settings', t('menu.settings')) +
        '</div>';
    } else {
      panel.innerHTML =
        '<div class="opts settings">' +
          `<h2>${escapeHtml(t('menu.settings.title'))}</h2>` +
          this.toggle('invertLookX', t('menu.settings.invertX'), this.prefs.invertLookX) +
          this.toggle('invertLookY', t('menu.settings.invertY'), this.prefs.invertLookY) +
          `<div class="note">${escapeHtml(t('menu.settings.controllerNote'))}</div>` +
          `<div class="row lang"><span class="lbl">${escapeHtml(t('menu.settings.language'))}</span>` +
          `<div class="langs">${languages().map((l) =>
            `<button class="bs-menu-btn chip${l.code === language() ? ' on' : ''}" type="button" ` +
            `data-lang="${l.code}">${escapeHtml(l.nativeName)}</button>`).join('')}</div></div>` +
          this.btn('back', t('menu.back')) +
        '</div>';
    }

    this.focusables = Array.from(panel.querySelectorAll('button:not([disabled])'));
    // Where the cursor lands is stated by whoever asked for this panel, never
    // inherited from the last one. Carrying an INDEX across a rebuild is what
    // put the cursor on Settings after a mouse click had moved it elsewhere —
    // the number was still pointing at a button from a list that no longer
    // existed. A selector survives a list changing length, and the fallback is
    // always the top of the new list.
    const want = this.pendingFocus;
    this.pendingFocus = null;
    const found = want ? panel.querySelector<HTMLButtonElement>(want) : null;
    this.focusIdx = found ? Math.max(0, this.focusables.indexOf(found)) : 0;
    this.focusables[this.focusIdx]?.focus();
  }

  private btn(action: string, label: string, mod = ''): string {
    const dis = mod === 'disabled' ? ' disabled' : '';
    return `<button class="bs-menu-btn ${mod}" type="button" data-act="${action}"${dis}>` +
      `${escapeHtml(label)}</button>`;
  }

  /**
   * A settings row whose control is a button, not a checkbox.
   *
   * `<input type=checkbox>` would come with focus and keyboard behaviour for
   * free, but it also comes with a native box that no amount of CSS makes match
   * the rest of this screen, and the pad poll below drives everything by
   * `.click()` on a button anyway. So the row IS the button, with the state as
   * an ON/OFF pill on its right, and `aria-pressed` carrying the state for
   * anything reading the page rather than looking at it.
   */
  private toggle(key: 'invertLookX' | 'invertLookY', label: string, on: boolean): string {
    return `<button class="bs-menu-btn row" type="button" data-toggle="${key}" ` +
      `aria-pressed="${on}"><span class="lbl">${escapeHtml(label)}</span>` +
      `<span class="pill">${escapeHtml(on ? t('menu.on') : t('menu.off'))}</span></button>`;
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  private onClick = (e: MouseEvent): void => {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    // Step one takes ANY click, anywhere on the poster — "press start" means
    // press anything, and on a phone the whole screen is the button.
    if (this.step === 'press') {
      this.advanceFromPress();
      return;
    }

    const btn = target.closest('button') as HTMLButtonElement | null;
    if (!btn) return;

    const lang = btn.getAttribute('data-lang');
    if (lang) {
      // The re-render is driven by the language event, not from here, so the
      // picker takes exactly the same path as any other language listener.
      setLanguage(lang);
      return;
    }

    const toggle = btn.getAttribute('data-toggle') as 'invertLookX' | 'invertLookY' | null;
    if (toggle) {
      const next = !this.prefs[toggle];
      this.prefs = savePrefs({ [toggle]: next });
      this.hooks.onLookAxes(toggle === 'invertLookX' ? { invertX: next } : { invertY: next });
      // Rewrite the one pill rather than re-rendering the panel: a rebuild would
      // drop focus back to the top of the list mid-way through changing things.
      btn.setAttribute('aria-pressed', String(next));
      const pill = btn.querySelector('.pill');
      if (pill) pill.textContent = next ? t('menu.on') : t('menu.off');
      return;
    }

    switch (btn.getAttribute('data-act')) {
      case 'new': this.start(); break;
      case 'settings': this.goto('settings'); break;
      // Back puts the cursor on the entry that opened Settings, not at the top
      // of the list — coming out of a submenu should leave you where you went in.
      case 'back': this.goto('options', '[data-act="settings"]'); break;
      default: break;
    }
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.el) return;
    // Modifier-only presses are not "any button" — a player resting a hand on
    // Shift would skip the splash they never saw.
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
    // F5, F12 and the devtools keys stay the browser's.
    if (e.ctrlKey || e.metaKey || e.altKey || /^F\d+$/.test(e.key)) return;

    if (this.step === 'press') {
      e.preventDefault();
      this.advanceFromPress();
      return;
    }

    switch (e.key) {
      case 'ArrowDown': case 's': case 'S':
        e.preventDefault(); this.moveFocus(1); break;
      case 'ArrowUp': case 'w': case 'W':
        e.preventDefault(); this.moveFocus(-1); break;
      case 'ArrowLeft': case 'ArrowRight':
        // Left/right belongs to the language chips, which are a row inside a
        // column; anywhere else it does nothing rather than jumping the list.
        if (document.activeElement?.hasAttribute('data-lang')) {
          e.preventDefault();
          this.moveFocus(e.key === 'ArrowRight' ? 1 : -1);
        }
        break;
      case 'Escape':
        if (this.step === 'settings') {
          e.preventDefault();
          this.goto('options', '[data-act="settings"]');
        }
        break;
      default:
        // Enter/Space land on the focused <button> natively. Nothing to do.
        break;
    }
  };

  private moveFocus(d: number): void {
    if (!this.focusables.length) return;
    const here = this.focusables.indexOf(document.activeElement as HTMLButtonElement);
    const from = here >= 0 ? here : this.focusIdx;
    this.focusIdx = (from + d + this.focusables.length) % this.focusables.length;
    this.focusables[this.focusIdx].focus();
  }

  /**
   * The pad, polled once per animation frame while the menu is up.
   *
   * Its own poll rather than `GamepadControls`: that class exists to feed the
   * game's Input with look deltas and held actions, and what a menu wants is the
   * opposite — edges only, no axes integrated over time, no coupling to a system
   * that is about to be handed a live hero. Twenty bytes of previous-state and a
   * latch on the stick is the whole of it.
   *
   * A pad CANNOT satisfy the fullscreen step: `requestFullscreen()` needs a user
   * activation and a gamepad press is not one in any browser. That step is
   * touch-only in practice, so this is a note rather than a guard — a pad press
   * on YES leaves the game windowed, which is the same outcome the pill already
   * tolerates when the browser refuses.
   */
  private pollPad = (): void => {
    if (!this.el) return;
    this.padRaf = requestAnimationFrame(this.pollPad);

    let pad: Gamepad | null = null;
    try {
      for (const p of navigator.getGamepads?.() ?? []) {
        if (p?.connected) { pad = p; break; }   // first connected pad wins
      }
    } catch {
      return; // no Gamepad API: keyboard and touch still work
    }
    if (!pad) {
      // Unplugged mid-menu: forget the held state, or the button that was down
      // when it went reads as a fresh press when a pad comes back.
      this.padDown.fill(0);
      return;
    }

    // ONE sweep over every button, updating held state and recording the rising
    // edges. It has to cover them all — that is what makes "press any button"
    // mean any button — and the three the lists care about read their edge out
    // of the same pass rather than polling the pad a second time.
    let any = false;
    const n = Math.min(pad.buttons.length, this.padDown.length);
    for (let i = 0; i < n; i++) {
      const now = pad.buttons[i]?.pressed ? 1 : 0;
      const edge = now === 1 && this.padDown[i] === 0 ? 1 : 0;
      this.padEdge[i] = edge;
      this.padDown[i] = now;
      if (edge) any = true;
    }

    if (this.step === 'press') {
      if (any) this.advanceFromPress();
      return;
    }

    // 12/13 are d-pad up/down in the W3C standard mapping, the same indices
    // core/gamepad.ts reads. Axis 1 is the left stick's Y, latched so a held
    // stick steps the list once instead of sixty times a second.
    const stick = pad.axes[1] ?? 0;
    const dir = stick < -0.5 ? -1 : stick > 0.5 ? 1 : 0;
    if (dir === 0) this.padAxisLatched = false;

    let move = 0;
    if (this.padEdge[12]) move = -1;
    else if (this.padEdge[13]) move = 1;
    else if (dir !== 0 && !this.padAxisLatched) { move = dir; this.padAxisLatched = true; }
    if (move) this.moveFocus(move);

    // A activates, B goes back — the console convention, and the same faces
    // core/gamepad.ts names for the rest of the game.
    if (this.padEdge[0]) (document.activeElement as HTMLButtonElement | null)?.click();
    else if (this.padEdge[1] && this.step === 'settings') {
      this.goto('options', '[data-act="settings"]');
    }
  };

  // -------------------------------------------------------------------------
  // Steps
  // -------------------------------------------------------------------------

  /**
   * Leave the splash. On a touch device the next thing is the fullscreen
   * question; everywhere else it is the options.
   */
  private advanceFromPress(): void {
    if (this.step !== 'press') return;
    if (this.askFullscreen()) this.goto('fullscreen');
    else this.goto('options');
  }

  /**
   * Raise the fullscreen pill as this step, and say whether it went up.
   *
   * ALWAYS ASKED, which is the one way this differs from the pill the game used
   * to raise on its own: that one remembered the answer and never asked twice,
   * and here that is wrong. The question decides how the
   * entire session is framed, it is being asked at the one moment the player is
   * deciding to play rather than mid-walk, and a phone that was rotated or
   * handed to somebody else since last time has a different right answer. The
   * cost is that someone who always says no is asked again next launch — a
   * two-button tap on a screen they are already looking at.
   *
   * The feature detect is NOT bypassed. On an iPhone, where no element-level
   * Fullscreen API exists, the step is skipped entirely rather than offering a
   * YES that cannot do anything.
   */
  private askFullscreen(): boolean {
    this.fsPrompt = FullscreenPrompt.ask({
      inMenu: true,
      onAnswer: () => {
        this.fsPrompt = null;
        this.goto('options');
      },
    });
    return this.fsPrompt !== null;
  }

  private goto(step: Step, focus?: string): void {
    this.step = step;
    this.pendingFocus = focus ?? null;
    this.renderPanel();
  }

  /**
   * New Game: fade the poster out, take it off the DOM, and only then tell
   * main.ts to run. The order matters — the hero's first frames are rendered
   * behind nothing at all rather than behind a dissolving image the compositor
   * is still blending.
   */
  private start(): void {
    const el = this.el;
    if (!el) return;
    el.classList.add('leaving');
    // FIRST, and before anything waits on a transition: from this moment the
    // poster is see-through and whatever is behind it is on screen.
    this.hooks.onLeave?.();
    const done = (): void => {
      if (!this.el) return;   // disposed mid-fade
      this.close();
      this.hooks.onStart();
    };
    // `transitionend` is the right signal, and the timer is the safety net for
    // the case where the transition never runs at all (prefers-reduced-motion,
    // a background tab, a browser that dropped the frame). Whichever lands
    // first wins; `close()` is idempotent.
    el.addEventListener('transitionend', done, { once: true });
    window.setTimeout(done, 700);
  }

  private close(): void {
    if (this.padRaf) cancelAnimationFrame(this.padRaf);
    this.padRaf = 0;
    this.unlisten?.();
    this.unlisten = null;
    window.removeEventListener('keydown', this.onKeyDown, true);
    this.fsPrompt?.dispose();
    this.fsPrompt = null;
    this.el?.remove();
    this.el = null;
  }

  dispose(): void {
    this.close();
  }
}
