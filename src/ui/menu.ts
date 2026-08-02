import { isTouchPrimary } from '../core/touch';
import { loadPrefs, type Prefs } from '../core/prefs';
import { flags } from '../core/flags';
import { t, language, onLanguageChange } from '../i18n';
import { enterFullscreen } from './fullscreen';
import { SettingsPanel, type SettingsHooks } from './settings';
import { injectStyles } from './styles';
import bgUrl from './menu-bg.webp';
import logoUrl from './menu-logo.webp';

/**
 * The title screen — splash, "Press start...", then New Game / Load / Settings.
 *
 * WHAT IT IS MADE OF
 *
 * Two pictures and CSS. `menu-bg.webp` and `menu-logo.webp`, sitting next to
 * this file, are the only art files in the whole project, and they are a
 * deliberate exception to the "everything is generated in code" rule that
 * governs the game itself: this is a 2D poster, not a thing the renderer has to
 * build, and a painted splash is the one place where an image IS the design.
 * Everything moving on top of them — the lantern pulse, the fairies, the logo's
 * slide — is CSS animation, so the menu costs no JavaScript per frame. The only
 * per-frame work while it is up is the gamepad poll below, and that only runs
 * if the page can see a pad at all.
 *
 * THEY ARE IMPORTED, NOT PUT IN `public/`, and that is a correctness choice
 * rather than a filing one. `vite.config.ts` sets `base:'./'` so a build can be
 * served from any subfolder — which is exactly what `bun run snapshot`
 * produces — and Vite does not rewrite string literals in JS. Under `public/`
 * the URL therefore had to be computed at RUNTIME against `document.baseURI`,
 * which is one more thing that has to be right on every way of serving the
 * build. Imported, the bundler emits the file with a content hash and writes
 * the relative URL itself, by the same machinery that already resolves
 * `main-*.js`: if the page can load its own JavaScript it can load these.
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
 *   press -> options -> settings -> options
 *
 * There used to be a fullscreen step between the first two, asking "Play
 * fullscreen?" on every launch. It is gone: the game goes fullscreen when New
 * Game is pressed, and Settings carries a switch to stop it. See
 * `Prefs.autoFullscreen` for why a question was the wrong shape, and
 * ui/fullscreen.ts for why the request has to be issued from the gesture.
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
 * Measured off `menu-bg.webp` (1672x941) by zooming on each lantern and
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

type Step = 'press' | 'options' | 'settings';

/**
 * What the title screen needs from its host, beyond the settings hooks it passes
 * straight through to `SettingsPanel` (ui/settings.ts — the rows themselves, and
 * everything they persist, moved there when the pause menu needed the same list).
 */
export interface StartMenuHooks extends SettingsHooks {
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
}

/** How a caller wants this instance to open. See `offer`. */
export interface StartMenuOptions {
  /**
   * Open on the OPTIONS step rather than on the splash.
   *
   * For the one caller that raises a second title screen in the same page: Exit
   * to title, from the in-game menu (main.ts). Every other route here is a fresh
   * load, where the splash is the first thing anyone sees and is the point.
   */
  skipSplash?: boolean;
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
  /** The settings list, shared with the in-game menu. See ui/settings.ts. */
  private settings: SettingsPanel;
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
  static offer(hooks: StartMenuHooks, opts: StartMenuOptions = {}): StartMenu | null {
    const p = menuParam();
    if (p === '0') return null;
    if (p !== '1' && flags.photo) return null;
    return new StartMenu(hooks, p === '1' && flags.photo, opts);
  }

  private constructor(
    private hooks: StartMenuHooks, private frozen: boolean, opts: StartMenuOptions,
  ) {
    injectStyles();
    this.prefs = loadPrefs();
    this.settings = new SettingsPanel('title', hooks);
    // Coming back from a game skips the splash. "Press start..." is an invitation
    // to a player who has not started, and someone who just chose Exit to title
    // has plainly started — making them press a key to be shown the menu they
    // asked for is a step that answers nothing.
    if (opts.skipSplash) this.step = 'options';

    const el = document.createElement('div');
    el.className = `bs-menu${this.frozen ? ' photo' : ''}`;
    el.setAttribute('data-step', this.step);
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
          `<img class="art" src="${bgUrl}" alt="" draggable="false">` +
          lamps +
        '</div>' +
        `<div class="flies">${fairies}</div>` +
        '<div class="vign"></div>' +
      '</div>' +
      '<div class="fore">' +
        `<img class="logo" src="${logoUrl}" ` +
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
    } else if (this.step === 'options') {
      panel.innerHTML =
        '<div class="bs-opts">' +
          this.btn('new', t('menu.newGame'), 'primary') +
          this.btn('load', t('menu.load'), 'disabled') +
          `<div class="note">${escapeHtml(t('menu.load.unavailable'))}</div>` +
          this.btn('settings', t('menu.settings')) +
        '</div>';
    } else {
      // The rows come from ui/settings.ts, which is also what the in-game menu
      // shows. This screen contributes the column around them and the way out.
      panel.innerHTML =
        '<div class="bs-opts settings">' +
          this.settings.markup() +
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

    // The settings list handles its own rows — the language chips and every
    // toggle — and says so. Anything it does not claim is one of this screen's
    // own buttons, below.
    if (this.settings.handleClick(btn)) {
      this.prefs = this.settings.values;
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
        // Left/right is for the one thing laid out as a ROW: the language
        // chips inside the settings column. Anywhere else it does nothing
        // rather than jumping the list sideways for no reason.
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
   * A pad cannot take the game fullscreen: `requestFullscreen()` needs a user
   * activation and a gamepad press is not one in any browser. Starting from a
   * controller therefore stays windowed however `autoFullscreen` is set, which
   * is a note rather than a guard — nothing here can route around it.
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
   * Leave the splash, straight to the options.
   */
  private advanceFromPress(): void {
    if (this.step !== 'press') return;
    this.goto('options');
  }

  private goto(step: Step, focus?: string): void {
    this.step = step;
    this.pendingFocus = focus ?? null;
    this.renderPanel();
  }

  /**
   * New Game: go fullscreen, fade the poster out, take it off the DOM, and only
   * then tell main.ts to run. The order matters — the hero's first frames are
   * rendered behind nothing at all rather than behind a dissolving image the
   * compositor is still blending.
   */
  private start(): void {
    const el = this.el;
    if (!el) return;

    // BEFORE ANYTHING ELSE, because this is the only statement here that has a
    // deadline. `requestFullscreen()` is honoured only while the browser can
    // attribute it to the user activation that got us here — the click or the
    // Enter on New Game — so it goes ahead of the class change, the hooks and
    // the transition. Deferring it by even a promise tick is how this silently
    // stops working. See ui/fullscreen.ts.
    //
    // The URL beats the preference and never writes it back, the same
    // resolution the look-axis and shake overrides use: `fs=0` is how every
    // probe in tools/ that clicks New Game keeps the viewport from being
    // resized under a measurement. A pad press is not a user activation in any
    // browser, so starting the game from a controller stays windowed whatever
    // this says, and that is a browser rule rather than a decision.
    if (flags.autoFullscreen ?? this.prefs.autoFullscreen) enterFullscreen();

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
    //
    // BOTH GUARDS ON THE EVENT ARE LOAD-BEARING, and the bug they fix was
    // measured rather than imagined. `transitionend` BUBBLES, and the button
    // that was just clicked has `transition: transform .14s, filter .14s`
    // (see .bs-menu-btn) — so releasing `:active` on New Game fired one at the
    // menu 140 ms in and closed the poster a third of the way through its own
    // half-second dissolve. Sampled 180 ms after the click, the loading screen
    // behind it was already at 0.60 opacity and fading: the player saw a cut,
    // not a fade. Only this element, and only its opacity, ends the fade.
    el.addEventListener('transitionend', function onEnd(e: TransitionEvent) {
      if (e.target !== el || e.propertyName !== 'opacity') return;
      el.removeEventListener('transitionend', onEnd);
      done();
    });
    window.setTimeout(done, 700);
  }

  private close(): void {
    if (this.padRaf) cancelAnimationFrame(this.padRaf);
    this.padRaf = 0;
    this.unlisten?.();
    this.unlisten = null;
    window.removeEventListener('keydown', this.onKeyDown, true);
    this.el?.remove();
    this.el = null;
  }

  dispose(): void {
    this.close();
  }
}
