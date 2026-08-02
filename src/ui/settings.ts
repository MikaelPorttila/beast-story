import { loadPrefs, savePrefs, type Prefs } from '../core/prefs';
import { t, language, languages, setLanguage } from '../i18n';
import type { LookAxes } from '../core/gamepad';

/**
 * THE SETTINGS PANEL — one view, two places it is shown from.
 *
 * It used to be a branch inside `StartMenu.renderPanel`, which was right while
 * the title screen was the only way to reach it. The in-game menu (ui/pause.ts)
 * is the second, and a second copy of this list is the wrong answer to that in
 * the specific way that duplicated UI always is: the copies do not diverge on
 * the day they are written, they diverge on the day someone adds a row to one of
 * them. So the markup, the click handling and the persistence live here, and
 * both hosts render what this returns into a container of their own.
 *
 * WHAT A HOST OWNS AND WHAT THIS DOES
 *
 * This owns everything about a SETTING: what rows there are, what they say, what
 * a click on one writes, and what it tells the running game. A host owns
 * everything about a SCREEN: where the panel sits, what surrounds it, which
 * button the cursor starts on, and what "back" means. The seam is `markup()` and
 * `handleClick()` — a host puts the string somewhere and forwards clicks it does
 * not recognise, and gets working settings.
 *
 * WHERE IT IS BEING SHOWN IS PART OF THE VIEW
 *
 * `place` is not decoration. A setting can be answerable at the title screen and
 * unanswerable once a world exists, and there is already one: LANGUAGE.
 * `setLanguage` re-derives every string on its way to the DOM, which covers the
 * HUD, the touch overlay and the menu — but a fingerpost's letters are VOXEL
 * GEOMETRY, carved once at world creation (see world/town-parts.ts and the note
 * in AGENTS.md), and no live switch can re-cut them. Offering the picker in-game
 * would therefore leave a player who used it walking a world signposted in the
 * language they just left. So in-game it is shown DISABLED with a line saying
 * why, rather than hidden: a setting that vanishes reads as a bug, and a player
 * who came looking for it deserves to be told where it is.
 *
 * Disabled rather than hidden is also what keeps the two panels the same shape,
 * which is the whole point of there being one of them.
 */

/**
 * Which screen the panel is being shown from.
 *
 * 'title' is the start menu, before a world exists. 'game' is the pause menu,
 * with a hero standing in one.
 */
export type SettingsPlace = 'title' | 'game';

/**
 * The settings shown as an ON/OFF row.
 *
 * Every one is a boolean `Prefs` field, which is what lets a row read its own
 * state and write the new one straight off the key in `data-toggle` — the markup
 * and the persistence never spell a setting's name twice. What each one MEANS to
 * the running game is still a hook below, because that differs per setting.
 */
type ToggleKey = 'hapticFeedback' | 'invertLookX' | 'invertLookY' | 'autoFullscreen';

export interface SettingsHooks {
  /**
   * A look-axis toggle moved. Applied LIVE rather than on close: the pad is
   * already connected while the panel is up, and someone flipping "invert Y" is
   * about to test it. Persisting is this module's job, not the caller's.
   */
  onLookAxes: (a: Partial<LookAxes>) => void;
  /**
   * The controller-vibration switch moved. Live for the same reason, and for
   * one more: a player turning it OFF is usually asking for it to stop, and a
   * setting that only takes effect at the next launch does not answer that.
   */
  onHapticFeedback: (on: boolean) => void;
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

export class SettingsPanel {
  private prefs: Prefs;

  /**
   * `place` is fixed for the life of the panel, because a panel belongs to a
   * screen: the title screen's is built once at boot, the pause menu's once per
   * game. Nothing has to re-derive a row when it changes, because it cannot.
   */
  constructor(readonly place: SettingsPlace, private hooks: SettingsHooks) {
    this.prefs = loadPrefs();
  }

  /** The stored values as this panel last read or wrote them. */
  get values(): Prefs { return this.prefs; }

  /**
   * The list, as HTML, for a host to put inside its own container.
   *
   * Returns the ROWS and not a wrapper, so a host decides what surrounds them —
   * the title screen puts them in the same `.bs-opts` column its New Game button
   * lives in, the pause menu in a panel of its own. `.bs-opts` is what carries
   * the shared look (ui/styles.ts); it is deliberately not scoped to either host.
   */
  markup(): string {
    const inGame = this.place === 'game';
    return (
      `<h2>${escapeHtml(t('menu.settings.title'))}</h2>` +
      this.toggle('hapticFeedback', t('menu.settings.hapticFeedback'), this.prefs.hapticFeedback) +
      this.toggle('invertLookX', t('menu.settings.invertX'), this.prefs.invertLookX) +
      this.toggle('invertLookY', t('menu.settings.invertY'), this.prefs.invertLookY) +
      // The note belongs to the two INVERT rows — it says the mouse is never
      // inverted — so anything added below it must go after it, not between.
      `<div class="note">${escapeHtml(t('menu.settings.controllerNote'))}</div>` +
      this.toggle('autoFullscreen', t('menu.settings.autoFullscreen'), this.prefs.autoFullscreen) +
      `<div class="row lang${inGame ? ' off' : ''}">` +
        `<span class="lbl">${escapeHtml(t('menu.settings.language'))}</span>` +
        `<div class="langs">${languages().map((l) =>
          `<button class="bs-menu-btn chip${l.code === language() ? ' on' : ''}" type="button" ` +
          `data-lang="${l.code}"${inGame ? ' disabled' : ''}>` +
          `${escapeHtml(l.nativeName)}</button>`).join('')}</div></div>` +
      // Only in-game, and only under the row it explains. A disabled control with
      // no reason beside it is indistinguishable from a broken one.
      (inGame ? `<div class="note">${escapeHtml(t('menu.settings.languageInGame'))}</div>` : '')
    );
  }

  /**
   * Handle a click on something inside the panel. Returns whether it was ours.
   *
   * A host forwards every button it does not recognise and gets working
   * settings; a `false` means "not a settings control, deal with it yourself".
   * Taking the BUTTON rather than the event is deliberate — both hosts already
   * resolve `event.target.closest('button')` for their own rows, and passing the
   * resolved element means this never has to agree with a host about which
   * element a click counts as.
   */
  handleClick(btn: HTMLElement): boolean {
    const lang = btn.getAttribute('data-lang');
    if (lang) {
      // Never reachable in-game — the chips are `disabled` there — but checked
      // rather than trusted, because "the markup says so" is not a guard.
      if (this.place === 'game') return true;
      // The re-render is driven by the language event, not from here, so the
      // picker takes exactly the same path as any other language listener.
      setLanguage(lang);
      return true;
    }

    const toggle = btn.getAttribute('data-toggle') as ToggleKey | null;
    if (!toggle) return false;

    const next = !this.prefs[toggle];
    this.prefs = savePrefs({ [toggle]: next });
    if (toggle === 'hapticFeedback') this.hooks.onHapticFeedback(next);
    else if (toggle === 'invertLookX') this.hooks.onLookAxes({ invertX: next });
    else if (toggle === 'invertLookY') this.hooks.onLookAxes({ invertY: next });
    // `autoFullscreen` has no hook: it is read at the moment New Game is pressed
    // (ui/fullscreen.ts) and there is nothing to tell now.

    // Rewrite the one pill rather than asking the host to re-render: a rebuild
    // would drop focus back to the top of the list mid-way through changing
    // things, which on a pad is the cursor jumping out from under your thumb.
    btn.setAttribute('aria-pressed', String(next));
    const pill = btn.querySelector('.pill');
    if (pill) pill.textContent = next ? t('menu.on') : t('menu.off');
    return true;
  }

  /**
   * A settings row whose control is a button, not a checkbox.
   *
   * `<input type=checkbox>` would come with focus and keyboard behaviour for
   * free, but it also comes with a native box that no amount of CSS makes match
   * the rest of these screens, and both hosts' pad polls drive everything by
   * `.click()` on a button anyway. So the row IS the button, with the state as
   * an ON/OFF pill on its right, and `aria-pressed` carrying the state for
   * anything reading the page rather than looking at it.
   */
  private toggle(key: ToggleKey, label: string, on: boolean): string {
    return `<button class="bs-menu-btn row" type="button" data-toggle="${key}" ` +
      `aria-pressed="${on}"><span class="lbl">${escapeHtml(label)}</span>` +
      `<span class="pill">${escapeHtml(on ? t('menu.on') : t('menu.off'))}</span></button>`;
  }
}
