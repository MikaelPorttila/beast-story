import { t, language, onLanguageChange } from '../i18n';
import { SettingsPanel, type SettingsHooks } from './settings';
import { injectStyles } from './styles';

/**
 * THE IN-GAME MENU — Continue, Settings, Exit to title.
 *
 * Reached by Escape, by Start on a pad, and by the menu button on the touch
 * overlay: the one control every device has a way to press, which is the whole
 * requirement. What it is, structurally, is a MODAL with a cursor — the same
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
 * and Escape means "up one", which is what makes a single key both the way in
 * and the whole way out. `onEscape` below is the contract for that: the host
 * calls it and is told whether the press was spent.
 */

type Step = 'menu' | 'settings';

export interface PauseMenuHooks extends SettingsHooks {
  /** The menu is up. The host freezes the hero and stands the pad down. */
  onOpen?: () => void;
  /** The menu is gone, by Continue or by Escape. The game resumes. */
  onClose?: () => void;
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

  constructor(private hooks: PauseMenuHooks) {
    injectStyles();
    // 'game' is what disables the language picker and explains why — the one
    // setting that cannot be answered with a world already streamed. See
    // ui/settings.ts.
    this.settings = new SettingsPanel('game', hooks);
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

  close(): void {
    if (!this.el) return;
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
    this.hooks.onClose?.();
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
    else this.close();
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

    this.focusables = Array.from(pane.querySelectorAll('button:not([disabled])'));
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
        // Left/right is for the one thing laid out as a ROW, the language chips,
        // and they are disabled in game — so this does nothing today and is kept
        // because the row is shared markup and may not always be.
        if (document.activeElement?.hasAttribute('data-lang')) {
          e.preventDefault();
          this.moveFocus(e.key === 'ArrowRight' ? 1 : -1);
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
        this.close();
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

    // A activates. B is deliberately NOT read here: `GamepadControls` already
    // taps a virtual Escape for both B and Start while a modal is up, and the
    // host routes that into `onEscape` — reading it a second time would close
    // two steps at once.
    if (this.padEdge[0]) this.activate();
  };
}
