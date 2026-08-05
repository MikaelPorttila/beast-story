import { isTouchPrimary } from '../core/touch';
import { loadPrefs, type Prefs } from '../core/prefs';
import { flags } from '../core/flags';
import { t, language, onLanguageChange } from '../i18n';
import { enterFullscreen, fullscreenSurvivesEscape } from './fullscreen';
import { SettingsPanel, FOCUSABLE, type SettingsHooks } from './settings';
import { aboutMarkup } from './about';
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
 *                    \-> about  -> options
 *
 * ABOUT is the second leaf off the options, and it is a leaf in the same sense
 * Settings is: one way in, one way back, and the way back puts the cursor on the
 * button that opened it. What it holds — what the game is, the AI disclaimer and
 * the third-party licences — lives in ui/about.ts for the same reason the
 * settings rows live in ui/settings.ts, which is that a second host would
 * otherwise be a second copy.
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

type Step = 'press' | 'options' | 'settings' | 'about';

/**
 * How far one arrow key or d-pad nudge scrolls the About box, in px.
 *
 * The About step is the one screen here with no list to walk: it is a single
 * Back button and a block of prose taller than the window, so up/down means
 * SCROLL rather than move-the-cursor (see `onKeyDown`). 64px is about three
 * lines at the 16px floor — enough that holding the key gets you down the panel
 * at a useful rate, short enough that one press never skips a heading.
 */
const ABOUT_SCROLL = 64;

/**
 * THE POSTER ASSEMBLES ITSELF, IN THREE BEATS: logo, then painting, then the
 * invitation to press something. Issue #49.
 *
 * The order is the argument. A splash that fades in as one flat image gives the
 * wordmark and the art the same weight at the same instant, and the eye lands on
 * whichever is brighter — which here is a noon sky, not the game's name. Lighting
 * the logo first against the dark backing plate makes it the only thing on screen
 * for half a second; the painting then arrives underneath something the player has
 * already read.
 *
 * IT WAITS FOR THE PIXELS FIRST, which is the "load off screen, then fade" half
 * of the request. An `<img>` fades in with whatever it has decoded, so a fade
 * begun on a cold cache is a fade of nothing followed by a pop;
 * `HTMLImageElement.decode()` resolves when the bitmap is ready to paint. Both
 * images are in the markup from the first frame, so the browser starts both
 * fetches immediately and this wait only orders the REVEAL, never the load —
 * measured on a cold dev server, both decode by 1.08 s. The cap is the safety
 * net: a decode that never resolves (or a browser without the method) must cost
 * the splash its wait, not the whole screen.
 *
 * THEN THE BEATS THEMSELVES ARE CSS, AND THAT IS THE PART THAT HAD TO BE
 * MEASURED. The obvious shape — light a layer, `setTimeout`, light the next — is
 * the one thing that cannot work here, because the boot is running behind this
 * poster and its phases are LONG TASKS: a timer set for 550 ms fired at 4066 ms,
 * so the painting arrived four seconds after the wordmark and the whole sequence
 * read as a stall. A compositor-driven opacity animation is immune to that; it
 * kept running smoothly through the same block that starved the timer. So JS
 * decides WHEN the sequence starts (the one thing a stylesheet cannot ask) and
 * the stylesheet owns the whole of the ordering, in `animation-delay`.
 *
 * NOT UNDER photo=1, AND NOT ON THE WAY BACK FROM A GAME. A staged capture wants
 * the finished poster and nothing in flight — `.bs-menu.photo` pauses animations,
 * so a still taken mid-intro would be of a half-lit screen — and Exit to title
 * raises a second menu whose art has been in the cache for the whole session,
 * where re-introducing it reads as the game reloading. Both jump straight to the
 * end state, which is the `lit` class rather than the `intro` one. A player who
 * presses anything mid-intro gets the same jump; see `advanceFromPress`.
 */
const INTRO = {
  /** How long a decode may hold the sequence up before it starts regardless. */
  decodeCap: 2500,
  /**
   * Wall-clock length of the whole sequence, ms: logo .55 + art .7 + press .45.
   * Must match the delays in ui/styles.ts. Read against `performance.now()`
   * rather than counted down by a timer, for the long-task reason above.
   */
  total: 1700,
} as const;

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
  private padAxisLatchedX = false;
  /**
   * When the three-beat entrance started, `performance.now()`. 0 = waiting for
   * the images, -1 = there is no sequence (finished, skipped, or never run).
   */
  private introAt = 0;

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
    // A tab replaces every row under it, so the panel asks for a real rebuild
    // rather than patching the DOM behind this screen's back — `focusables` is
    // built by `renderPanel` and by nothing else. Same path a language change
    // takes, and the selector is what keeps the cursor on the tab just pressed.
    this.settings.onRebuild = (focus) => { this.pendingFocus = focus; this.renderPanel(); };
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

    // The poster is on screen from that frame; what it shows is the dark backing
    // plate until the beats below light each layer. `.bs-menu.show` is what
    // tools/test-menu.mjs times, and it is deliberately still the same frame it
    // always was: the intro orders the REVEAL, it does not delay the screen.
    if (this.frozen || opts.skipSplash) this.finishIntro();
    else void this.runIntro();
  }

  // -------------------------------------------------------------------------
  // Entrance
  // -------------------------------------------------------------------------

  /** Every layer up, no sequence. The end state, the skip, and photo mode. */
  private finishIntro(): void {
    this.introAt = -1;
    this.el?.classList.remove('intro');
    this.el?.classList.add('lit');
  }

  /** Has the sequence had its whole run? See INTRO.total for why it is a clock. */
  private get introOver(): boolean {
    return this.introAt < 0 || performance.now() - this.introAt >= INTRO.total;
  }

  /** Wait for an image's bitmap, capped. See INTRO. */
  private static ready(img: HTMLImageElement | null): Promise<unknown> {
    if (!img) return Promise.resolve();
    return Promise.race([
      img.decode?.().catch(() => undefined) ?? Promise.resolve(),
      new Promise((r) => window.setTimeout(r, INTRO.decodeCap)),
    ]);
  }

  private async runIntro(): Promise<void> {
    const el = this.el;
    if (!el) return;
    // BOTH, in parallel. The images are ordered on SCREEN by the stylesheet, so
    // there is nothing to gain by fetching them in series — and a logo lit while
    // the painting is still arriving would put the first beat's whole length
    // between them however short the fade is.
    await Promise.all([
      StartMenu.ready(el.querySelector<HTMLImageElement>('img.logo')),
      StartMenu.ready(el.querySelector<HTMLImageElement>('img.art')),
    ]);
    // Disposed, or skipped by a keypress, while we waited: `lit` has already been
    // set and starting the animations now would fade a poster back in from black.
    if (this.el !== el || this.introAt !== 0) return;
    this.introAt = performance.now();
    el.classList.add('intro');
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
          this.btn('about', t('menu.about')) +
        '</div>';
    } else if (this.step === 'about') {
      // Same column and the same way out as the settings step. The panel itself
      // is ui/about.ts; this screen contributes the frame around it.
      panel.innerHTML =
        '<div class="bs-opts about-step">' +
          aboutMarkup() +
          this.btn('back', t('menu.back')) +
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

    // FOCUSABLE, not "every button": the settings panel's strips are one control
    // each and its hidden sections are still in the DOM. See ui/settings.ts.
    this.focusables = Array.from(panel.querySelectorAll(FOCUSABLE));
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
      case 'about': this.goto('about'); break;
      // Back puts the cursor on the entry that opened this step, not at the top
      // of the list — coming out of a submenu should leave you where you went in.
      case 'back': this.leaveLeaf(); break;
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
        e.preventDefault();
        if (!this.scrollAbout(1)) this.moveFocus(1);
        break;
      case 'ArrowUp': case 'w': case 'W':
        e.preventDefault();
        if (!this.scrollAbout(-1)) this.moveFocus(-1);
        break;
      case 'ArrowLeft': case 'ArrowRight':
        // Left/right CHANGES the value of whichever strip the cursor is on — the
        // tab, the volume level, the language — rather than walking the buttons
        // inside it. The panel owns that because the strips are its markup;
        // anywhere else the key does nothing rather than jumping the list
        // sideways for no reason.
        if (this.settings.stepGroup(document.activeElement, e.key === 'ArrowRight' ? 1 : -1)) {
          e.preventDefault();
        }
        break;
      case 'Escape':
        if (this.step === 'settings' || this.step === 'about') {
          e.preventDefault();
          this.leaveLeaf();
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

    // 12/13 are d-pad up/down in the W3C standard mapping and 14/15 left/right,
    // the same indices core/gamepad.ts reads. Axes 1 and 0 are the left stick,
    // latched so a held stick steps once instead of sixty times a second.
    const stickY = pad.axes[1] ?? 0;
    const dirY = stickY < -0.5 ? -1 : stickY > 0.5 ? 1 : 0;
    if (dirY === 0) this.padAxisLatched = false;
    const stickX = pad.axes[0] ?? 0;
    const dirX = stickX < -0.5 ? -1 : stickX > 0.5 ? 1 : 0;
    if (dirX === 0) this.padAxisLatchedX = false;

    let move = 0;
    if (this.padEdge[12]) move = -1;
    else if (this.padEdge[13]) move = 1;
    else if (dirY !== 0 && !this.padAxisLatched) { move = dirY; this.padAxisLatched = true; }
    // On the About step there is one button and a page of prose, so up/down is
    // the scroll — the same answer the arrow keys give, in the same helper. A
    // held stick is latched, so this steps rather than sliding; that is the
    // right feel for a d-pad and is what the keyboard does too.
    if (move && !this.scrollAbout(move)) this.moveFocus(move);

    // LEFT/RIGHT IS THE STRIP'S, and it is why a pad reaches the settings in one
    // step down rather than five: the tab strip is one control, so this changes
    // the SECTION rather than walking the four buttons that name it.
    let step = 0;
    if (this.padEdge[14]) step = -1;
    else if (this.padEdge[15]) step = 1;
    else if (dirX !== 0 && !this.padAxisLatchedX) { step = dirX; this.padAxisLatchedX = true; }
    if (step && this.step === 'settings') {
      this.settings.stepGroup(document.activeElement, step as -1 | 1);
    }

    // A activates, B goes back — the console convention, and the same faces
    // core/gamepad.ts names for the rest of the game.
    if (this.padEdge[0]) (document.activeElement as HTMLButtonElement | null)?.click();
    else if (this.padEdge[1] && (this.step === 'settings' || this.step === 'about')) {
      this.leaveLeaf();
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
    // A press during the entrance FINISHES it rather than skipping past it. The
    // words "press start" are not on screen yet, so the press was aimed at a
    // splash the player is still being shown — dropping them straight into the
    // options would answer a question they had not been asked, and would do it
    // by taking the poster away mid-fade. One more press, on a screen that is
    // now asking for it, costs nothing; the intro is a second and a quarter.
    if (!this.introOver) { this.finishIntro(); return; }
    this.goto('options');
  }

  /**
   * Out of a leaf step and back to the options, cursor on the button that
   * opened it.
   *
   * One method because there are three ways to ask — the Back button, Escape,
   * and the pad's B face — and two leaves to come out of. Deriving the focus
   * selector from the step rather than passing it in is what stops the third
   * leaf, whenever there is one, from being a fourth place to remember.
   */
  private leaveLeaf(): void {
    const from = this.step === 'about' ? 'about' : 'settings';
    this.goto('options', `[data-act="${from}"]`);
  }

  /**
   * Scroll the About box, if that is what up/down means right now. Returns
   * whether the key was spent.
   *
   * `false` everywhere else, so every caller stays one line: scroll, or fall
   * through to moving the cursor. It is deliberately not gated on `this.step`
   * alone — the element has to be there, or a rebuild mid-press would scroll
   * nothing and swallow the key.
   */
  private scrollAbout(dir: number): boolean {
    const box = this.el?.querySelector<HTMLElement>('.about');
    if (!box) return false;
    box.scrollTop += dir * ABOUT_SCROLL;
    return true;
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
    // resized under a measurement, and `fs=1` is the way to see the thing the
    // gate below otherwise refuses. A pad press is not a user activation in any
    // browser, so starting the game from a controller stays windowed whatever
    // this says, and that is a browser rule rather than a decision.
    //
    // THE GATE IS ISSUE #83. Where Escape still belongs to the browser, taking
    // fullscreen here hands the player a screen the first closed panel takes
    // back — so the preference is honoured only where the game can keep it
    // (ui/fullscreen.ts), and the settings row says so rather than sitting there
    // switched on and doing nothing.
    if (flags.autoFullscreen ?? (this.prefs.autoFullscreen && fullscreenSurvivesEscape())) {
      enterFullscreen();
    }

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
