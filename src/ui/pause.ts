import { t, language, onLanguageChange } from '../i18n';
import { SettingsPanel, FOCUSABLE, type SettingsHooks } from './settings';
import { enterFullscreen, isFullscreen, fullscreenWanted } from './fullscreen';
import { injectStyles } from './styles';

/**
 * THE IN-GAME MENU — Continue, Settings, Exit to title.
 *
 * Reached by F10, by the burger button in the HUD's corner, by Start on a pad,
 * and by the menu button on the touch overlay: the one control every device has
 * a way to press, which is the whole requirement. What it is, structurally, is a MODAL with a cursor — the same
 * bargain the F1 controls sheet makes (main.ts freezes the hero while it is up,
 * because a player who stopped to change a setting must not have walked off a
 * cliff while doing it) plus the focus handling the title screen has, because a
 * player who opened this with Start has no mouse to close it with.
 *
 * WHY IT IS NOT PART OF THE HUD
 *
 * The shop and the controls sheet live in ui/index.ts because they are views of
 * GAME STATE — offers, bindings — and the HUD is what draws game state. This is
 * a view of the SESSION: it turns the game off, changes preferences that outlive
 * it, and ends it. It belongs beside ui/menu.ts, which is the other screen that
 * does those things, and it shares that screen's settings list and its look. The
 * two are siblings; neither is a special case of the HUD.
 *
 * WHY IT LOOKS LIKE THE TITLE SCREEN AND NOT LIKE THE HUD
 *
 * Same reason. The HUD's cool glass is the language of things happening IN the
 * world; this is the language of things happening TO it, and a player arriving
 * here from the title screen should recognise where they are. So it reuses
 * `.bs-menu-btn` and `.bs-opts` — the second is why those rules are not scoped
 * to `.bs-menu` (see ui/styles.ts) — over a scrim rather than over a painting.
 *
 * THE STEPS
 *
 *   menu -> settings -> menu
 *
 * and a cancel means "up one", which is what makes one key both the way in and
 * the whole way out. `onEscape` below is the contract for that: the host calls
 * it and is told whether the press was spent. It is named for Escape and now
 * answers for F10 as well — the host folds the two into one cancel while this
 * menu is up, so the key that opened it closes it.
 */

type Step = 'menu' | 'settings';
/** How the menu was dismissed. See `PauseMenuHooks.onClose`. */
export type CloseBy = 'key' | 'click';

export interface PauseMenuHooks extends SettingsHooks {
  /** The menu is up. The host freezes the hero and stands the pad down. */
  onOpen?: () => void;
  /**
   * The menu is gone and the game resumes. `by` is HOW it was dismissed, and it
   * is on this contract for one reason: taking the pointer lock back is safe
   * after a CLICK and is not after a KEY. See the note on `close`.
   */
  onClose?: (by: CloseBy) => void;
  /**
   * Exit was chosen: end the session and put the title screen back.
   *
   * Everything about what that MEANS is the host's — disposing the actors,
   * leaving fullscreen, raising a new StartMenu. This is only the button.
   */
  onExit: () => void;
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

export class PauseMenu {
  private el: HTMLDivElement | null = null;
  private step: Step = 'menu';
  private settings: SettingsPanel;
  private unlisten: (() => void) | null = null;
  private padRaf = 0;
  /** Buttons of whichever step is showing, in focus order. */
  private focusables: HTMLButtonElement[] = [];
  private focusIdx = 0;
  /** Selector for the button the NEXT build should focus. See render. */
  private pendingFocus: string | null = null;
  /** Edge detection for the pad poll: held last frame, and went down this one. */
  private padDown = new Uint8Array(20);
  private padEdge = new Uint8Array(20);
  private padAxisLatched = false;
  private padAxisLatchedX = false;

  constructor(private hooks: PauseMenuHooks) {
    injectStyles();
    // 'game' is what disables the language picker and explains why — the one
    // setting that cannot be answered with a world already streamed. See
    // ui/settings.ts.
    this.settings = new SettingsPanel('game', hooks);
    // A tab replaces every row under it, so the panel asks for a real rebuild
    // rather than patching the DOM behind this screen's back — `focusables` is
    // built by `render` and by nothing else. Same path a language change takes.
    this.settings.onRebuild = (focus) => { this.pendingFocus = focus; this.render(); };
  }

  get isOpen(): boolean { return this.el !== null; }
  /** Which step is showing, or null when shut. Read by the probe in tools/. */
  get currentStep(): Step | null { return this.el ? this.step : null; }

  // -------------------------------------------------------------------------
  // Open / close
  // -------------------------------------------------------------------------

  open(): void {
    if (this.el) return;
    this.step = 'menu';
    const el = document.createElement('div');
    el.className = 'bs-pause';
    el.innerHTML = '<div class="bs-scrim"></div><div class="pane"></div>';
    this.el = el;
    document.body.appendChild(el);

    // A language change cannot happen from HERE — the picker is disabled in
    // game — but it can have happened at the title screen before this session,
    // and the listener costs nothing and keeps the two screens' behaviour the
    // same rather than subtly different.
    this.unlisten = onLanguageChange(() => {
      this.pendingFocus = `[data-lang="${language()}"]`;
      this.render();
    });

    el.addEventListener('click', this.onClick);
    window.addEventListener('keydown', this.onKeyDown, true);
    this.render();
    this.pollPad();
    // Next frame so the entrance transition has a start state to move from.
    requestAnimationFrame(() => el.classList.add('open'));
    this.hooks.onOpen?.();
  }

  /**
   * Shut the menu and give the game back.
   *
   * `restoreFullscreen` is false for the one caller that means it — Exit, which
   * is deliberately going back to a windowed title screen.
   *
   * PUTTING FULLSCREEN BACK IS THE FALLBACK for browsers with no keyboard lock,
   * and it is best-effort by construction rather than by sloppiness. Where the
   * lock exists (ui/fullscreen.ts) Escape never reached the browser and there is
   * nothing to put back. Where it does not — Brave nulls `navigator.keyboard`
   * outright — Escape drops fullscreen before the page has any say, and this is
   * the only way back into it.
   *
   * It asks the game's INTENT (`fullscreenWanted`) rather than sampling
   * `isFullscreen()` when the menu opened, because by then the browser has
   * usually already left: sampling gave `false` and the restore never fired at
   * all. `requestFullscreen()` is honoured only off a recent user activation, so
   * this works when the menu is dismissed by a CLICK on Continue — which is how
   * it is dismissed on a mouse. Closing with Escape or the pad reaches here from
   * a simulation slice with no activation behind it and the request is refused;
   * there is no arrangement in which a page can retake a fullscreen without a
   * gesture.
   *
   * `by` EXISTS BECAUSE OF WHAT ONE ESCAPE DOES IN A BROWSER WITHOUT THE LOCK.
   * That key is spent on the browser's own business — dropping pointer lock,
   * leaving fullscreen — and those land as separate events several
   * milliseconds apart. Measured: leaving fullscreen releases the pointer lock
   * 8 ms later. So a close that immediately re-takes the lock hands the browser
   * something to knock straight back out, and the loss reads as a fresh Escape:
   * the menu closed and then reopened on its own. That is what `by` is for —
   * the host re-takes the pointer after a CLICK, and waits for the next one
   * after a KEY. Nothing here is timed; the host asks whether the browser is
   * spending Escape at all (`escapeIsLocked`).
   */
  close(restoreFullscreen = true, by: CloseBy = 'click'): void {
    if (!this.el) return;
    // BEFORE the DOM work: a request issued from a click handler has a deadline
    // measured in the same terms `StartMenu.start` obeys — see ui/fullscreen.ts.
    if (restoreFullscreen && fullscreenWanted() && !isFullscreen()) enterFullscreen();
    if (this.padRaf) cancelAnimationFrame(this.padRaf);
    this.padRaf = 0;
    this.unlisten?.();
    this.unlisten = null;
    window.removeEventListener('keydown', this.onKeyDown, true);
    // Held pad state goes with the menu. A button still down when this closes
    // would otherwise read as a fresh press the next time it opens.
    this.padDown.fill(0);
    this.el.remove();
    this.el = null;
    this.focusables = [];
    this.hooks.onClose?.(by);
  }

  /**
   * The host saw Escape (or the pad's Start, which taps the same code). Returns
   * whether this menu spent it.
   *
   * ONE KEY, THREE MEANINGS, resolved here rather than at the call site: inside
   * Settings it goes back to the list, on the list it closes, and — the `false`
   * — when the menu is shut it was not ours and the host may open it. That is
   * the same "cancel closes the topmost thing" rule main.ts already applies to
   * the shop and the controls sheet, with this menu simply being the last one
   * left when everything else is down.
   */
  onEscape(): boolean {
    if (!this.el) return false;
    if (this.step === 'settings') this.goto('menu', '[data-act="settings"]');
    else this.close(true, 'key');
    return true;
  }

  dispose(): void {
    this.close();
  }

  // -------------------------------------------------------------------------
  // Markup
  // -------------------------------------------------------------------------

  private render(): void {
    const el = this.el;
    if (!el) return;
    const pane = el.querySelector('.pane') as HTMLDivElement;
    el.setAttribute('data-step', this.step);

    if (this.step === 'menu') {
      pane.innerHTML =
        '<div class="bs-opts">' +
          `<h2>${escapeHtml(t('pause.title'))}</h2>` +
          this.btn('continue', t('pause.continue'), 'primary') +
          this.btn('settings', t('pause.settings')) +
          this.btn('exit', t('pause.exit')) +
        '</div>';
    } else {
      pane.innerHTML =
        '<div class="bs-opts settings">' +
          this.settings.markup() +
          this.btn('back', t('menu.back')) +
        '</div>';
    }

    // FOCUSABLE, not "every button": the settings panel's strips are one control
    // each and its hidden sections are still in the DOM. See ui/settings.ts.
    this.focusables = Array.from(pane.querySelectorAll(FOCUSABLE));
    // Where the cursor lands is stated by whoever asked for this build, never
    // inherited — the same rule, and the same bug behind it, as the title
    // screen's `pendingFocus`: an INDEX carried across a rebuild points into a
    // list that no longer exists.
    const want = this.pendingFocus;
    this.pendingFocus = null;
    const found = want ? pane.querySelector<HTMLButtonElement>(want) : null;
    this.focusIdx = found ? Math.max(0, this.focusables.indexOf(found)) : 0;
    this.focusables[this.focusIdx]?.focus();
  }

  private btn(action: string, label: string, mod = ''): string {
    return `<button class="bs-menu-btn ${mod}" type="button" data-act="${action}">` +
      `${escapeHtml(label)}</button>`;
  }

  private goto(step: Step, focus?: string): void {
    this.step = step;
    this.pendingFocus = focus ?? null;
    this.render();
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  /**
   * Arrows and W/S move the cursor. Enter and Space are the platform's, because
   * every row is a real `<button>`.
   *
   * ESCAPE IS DELIBERATELY NOT HERE, and that is the one interesting line in
   * this listener. Escape reaches this menu from three devices — a key, the
   * pad's Start, and the touch overlay's MENU button — and the last two arrive
   * as a VIRTUAL press inside `Input`, not as a DOM event. Handling the real key
   * here as well would give the keyboard its own private path: one press seen
   * twice, once by this listener and once by the host's slice, closing two steps
   * at a time. So the host owns that edge for all three (see `onEscape`) and
   * this listener owns only what no device but a keyboard can send.
   *
   * `preventDefault` on the arrows stops the page scrolling under the menu; the
   * game behind is frozen either way, so nothing else is competing for them.
   */
  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.el) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case 'ArrowDown': case 's': case 'S':
        e.preventDefault(); this.moveFocus(1); break;
      case 'ArrowUp': case 'w': case 'W':
        e.preventDefault(); this.moveFocus(-1); break;
      case 'ArrowLeft': case 'ArrowRight':
        // Left/right CHANGES the value of whichever strip the cursor is on —
        // the tab, the volume level — rather than walking the buttons inside it.
        // The panel owns that because the strips are its markup; a `false` means
        // the cursor is on an ordinary row and the key is not ours.
        if (this.settings.stepGroup(document.activeElement, e.key === 'ArrowRight' ? 1 : -1)) {
          e.preventDefault();
        }
        break;
      default: break;
    }
  };

  moveFocus(d: number): void {
    if (!this.focusables.length) return;
    const here = this.focusables.indexOf(document.activeElement as HTMLButtonElement);
    const from = here >= 0 ? here : this.focusIdx;
    this.focusIdx = (from + d + this.focusables.length) % this.focusables.length;
    this.focusables[this.focusIdx].focus();
  }

  /** Enter/Space on the focused row, for hosts driving this from `Input`. */
  activate(): void {
    (document.activeElement as HTMLButtonElement | null)?.click();
  }

  private onClick = (e: MouseEvent): void => {
    const target = e.target as HTMLElement | null;
    if (!target || !this.el) return;
    // The scrim is not a way out. A shop is dismissed by clicking away from it
    // because the world behind it is still the thing you came for; this menu is
    // the thing you came for, and a stray click landing on Exit's neighbour is
    // not something to make one pixel of travel away from.
    const btn = target.closest('button') as HTMLButtonElement | null;
    if (!btn) return;

    if (this.settings.handleClick(btn)) return;

    switch (btn.getAttribute('data-act')) {
      case 'continue': this.close(); break;
      case 'settings': this.goto('settings'); break;
      // Back puts the cursor on the entry that opened Settings, not at the top
      // of the list — coming out of a submenu should leave you where you went in.
      case 'back': this.goto('menu', '[data-act="settings"]'); break;
      case 'exit':
        // Closed FIRST, so the host's teardown runs with no menu on screen and
        // nothing of this session's DOM left to raise a title screen behind.
        // `false`: Exit is going somewhere windowed on purpose, and the host
        // calls `exitFullscreen()` a line later anyway.
        this.close(false);
        this.hooks.onExit();
        break;
      default: break;
    }
  };

  /**
   * The pad, polled once per animation frame while the menu is up.
   *
   * Its own poll rather than `GamepadControls`, for the reason the title screen
   * gives: that class feeds a live hero with held actions and integrated axes,
   * and a menu wants edges. It is also STOOD DOWN while this is open
   * (`setModal`, core/gamepad.ts), so its Start button is not competing with the
   * one below — the only thing it still emits is the virtual Escape the host
   * routes back into `onEscape`.
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
      return; // no Gamepad API: keyboard, pointer and touch still work
    }
    if (!pad) { this.padDown.fill(0); return; }

    const n = Math.min(pad.buttons.length, this.padDown.length);
    for (let i = 0; i < n; i++) {
      const now = pad.buttons[i]?.pressed ? 1 : 0;
      this.padEdge[i] = now === 1 && this.padDown[i] === 0 ? 1 : 0;
      this.padDown[i] = now;
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
    if (move) this.moveFocus(move);

    // LEFT/RIGHT IS THE STRIP'S, and it is why a pad reaches the settings in one
    // step down rather than five: the tab strip is one control, so this changes
    // the SECTION rather than walking the four buttons that name it.
    let step = 0;
    if (this.padEdge[14]) step = -1;
    else if (this.padEdge[15]) step = 1;
    else if (dirX !== 0 && !this.padAxisLatchedX) { step = dirX; this.padAxisLatchedX = true; }
    if (step) this.settings.stepGroup(document.activeElement, step as -1 | 1);

    // A activates. B is deliberately NOT read here: `GamepadControls` already
    // taps a virtual Escape for both B and Start while a modal is up, and the
    // host routes that into `onEscape` — reading it a second time would close
    // two steps at once.
    if (this.padEdge[0]) this.activate();
  };
}
