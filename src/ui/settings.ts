import { loadPrefs, savePrefs, type Prefs } from '../core/prefs';
import { storedGfx, storeGfx, type GfxSinks } from '../core/gfx';
import { t, language, languages, setLanguage, type StringKey } from '../i18n';
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
 *
 * THE LIST IS FOUR SECTIONS, BEHIND TABS
 *
 * One flat column was right while there were five rows. It is not right at
 * eleven: the settings column was already the tallest thing the title screen
 * shows — there are two height media queries in ui/styles.ts written about
 * nothing else, and the second one exists because ONE row pushed the Back button
 * off the bottom of a 1000x560 window. Adding the graphics switches to the flat
 * list would have been another six.
 *
 * So the rows are grouped the way a player asks for them — how the game plays,
 * how it is driven, how it looks, how loud it is — and one group is on screen at
 * a time. The tallest tab is now shorter than the flat list ever was.
 *
 * A TAB IS NOT A STORAGE GROUP, and the two are allowed to differ. The keys are
 * `game.settings.<group>.<name>` with the group fixed on the day each setting
 * shipped (core/prefs.ts), and two of them no longer match the tab they are
 * shown in: music volume is stored under `gameplay` and shown under Sound,
 * "Fullscreen on start" under `graphics` and shown under Gameplay. Renaming a
 * key to tidy that up silently resets the choice of every player who already
 * made one, which is a worse thing than a name nobody sees.
 *
 * THE GRAPHICS ROWS ARE THE F3 PANEL'S OWN SWITCHES
 *
 * Not a copy of them — the same model, core/gfx.ts, the same five ids, the same
 * `game.settings.graphics.*` keys, so a row flipped here is flipped in the F3
 * panel and vice versa. What this file does NOT do is apply them: it writes
 * through `storeGfx` and tells its host, exactly as a `Prefs` row is saved here
 * and applied by a hook. The reason is the boot order in main.ts — this panel is
 * usable from the title screen while the engine and the world the sinks drive
 * are still being built, and the `Gfx` that owns them does not exist yet. A
 * change made in that window is picked up when it is constructed, because that
 * constructor reads the same storage this wrote.
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

/** Which section of the panel is showing. */
export type SettingsTab = 'gameplay' | 'controls' | 'graphics' | 'sound';

/**
 * The tabs, in the order they are shown, and the one place that order lives.
 *
 * Gameplay first because it is where a player who opened Settings for no
 * particular reason should land: it holds the language, which is the only row
 * here somebody might be looking for without knowing the game at all.
 */
const TABS: ReadonlyArray<{ id: SettingsTab; labelKey: StringKey }> = [
  { id: 'gameplay', labelKey: 'menu.settings.tab.gameplay' },
  { id: 'controls', labelKey: 'menu.settings.tab.controls' },
  { id: 'graphics', labelKey: 'menu.settings.tab.graphics' },
  { id: 'sound', labelKey: 'menu.settings.tab.sound' },
];

/**
 * The graphics rows: which of the F3 panel's switches a PLAYER is offered, and
 * what to call them here.
 *
 * FIVE OF THE NINE, and the four that are missing are missing on purpose. The
 * frame cap is a choice row rather than a switch and belongs beside a measured
 * frame rate, which is a thing the F3 panel has and this does not. Trees & rocks,
 * clouds and the water surface delete the WORLD rather than the way it is drawn
 * — a meadow with no trees in it is a different game, not a cheaper frame — and
 * the panel that offers those keeps its numbers beside them so the trade is
 * visible. Everything here is finishing work plus the ground cover, which is the
 * set a player can turn off and still be looking at the same place.
 *
 * ORDERED AS THE F3 PANEL ORDERS THEM, cheapest-to-lose first, because that
 * ordering is the closest either panel comes to advice (see GFX_OPTIONS).
 */
const GRAPHICS_ROWS: ReadonlyArray<{ id: keyof GfxSinks; labelKey: StringKey }> = [
  { id: 'ao', labelKey: 'menu.settings.ao' },
  { id: 'bloom', labelKey: 'menu.settings.bloom' },
  { id: 'aa', labelKey: 'menu.settings.aa' },
  { id: 'shadows', labelKey: 'menu.settings.shadows' },
  { id: 'grass', labelKey: 'menu.settings.foliage' },
];

/**
 * The music-volume row's steps, as percentages.
 *
 * CHIPS RATHER THAN A SLIDER, and rather than the −/+ stepper that was the
 * other candidate. Three things decided it. Every control on this screen is a
 * real `<button>`, because both hosts drive the panel from a pad by calling
 * `.click()` on the focused one (see the polls in ui/menu.ts and ui/pause.ts) —
 * an `<input type=range>` would need a bespoke path in two files and would
 * still look like nothing else here. A stepper puts mute eight presses away,
 * and "mute it completely" is the request. And a strip of chips is a shape this
 * panel already has, in the language row directly below, so it costs one row of
 * height rather than two — which matters, because the settings column is
 * already the tallest thing the title screen shows (see the height media
 * queries in ui/styles.ts).
 *
 * 0 is first and is labelled OFF rather than 0%: it is not a quiet setting, it
 * is the feature switched off, and nothing is loaded at all while it is chosen.
 * The steps are twenties so that the shipped default, 80, is one of them.
 */
const VOLUME_STEPS: ReadonlyArray<number> = [0, 20, 40, 60, 80, 100];

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
  /**
   * The music volume moved, 0..1. Live, and more obviously so than the other
   * two: this is the one setting on the panel whose effect the player can
   * already hear while they are looking at it.
   */
  onVolume: (v: number) => void;
  /**
   * A GRAPHICS row moved, and the value has already been stored.
   *
   * This is the apply half only, which is what makes it safe to call from the
   * title screen: the host pushes it at the live `Gfx` when there is one and
   * does nothing when there is not, and the `Gfx` built afterwards reads the
   * value out of storage anyway. Live for the same reason as everything else on
   * this panel, and more so — the whole argument for these being settings rather
   * than URL flags is that a switch you have to reload to try is a switch nobody
   * tries (see the header of core/gfx.ts).
   */
  onGraphics: (id: keyof GfxSinks, on: boolean) => void;
}

/**
 * Is this the focused element inside one of the panel's chip STRIPS — the tabs
 * across the top, the volume steps, or the language picker?
 *
 * Exported because it is a fact about this panel's markup that both hosts need:
 * left/right moves the cursor along a strip and does nothing anywhere else, and
 * each host owns its own key and pad handling. Asking here rather than each
 * host testing for `data-lang` itself is what stopped the arrow keys silently
 * skipping the volume row when it was added.
 */
export const isChip = (el: Element | null): boolean =>
  !!el && (el.hasAttribute('data-vol') || el.hasAttribute('data-lang')
    || el.hasAttribute('data-tab'));

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

export class SettingsPanel {
  private prefs: Prefs;
  /**
   * Which section is showing. Remembered for the life of the panel, so a player
   * who came for the graphics rows, went back and came in again is where they
   * left off rather than back at the top.
   */
  private tab: SettingsTab = 'gameplay';

  /**
   * Set by the HOST: this panel's markup changed shape and the screen around it
   * has to be rebuilt, with the cursor put back on `focus`.
   *
   * A tab click is the only thing that does this, and it cannot be handled the
   * way a toggle's pill is — that rewrites one node in place PRECISELY so the
   * host's `focusables` list stays valid, and a tab replaces every row below it.
   * The host owns focus (see the `pendingFocus` note in either of them), so the
   * host is asked to render. It is the same path a language change already
   * takes, and the selector is what stops the cursor jumping off the tab the
   * player just pressed.
   */
  onRebuild: ((focus: string) => void) | null = null;

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
   * Which volume chip is lit, as one of `VOLUME_STEPS`.
   *
   * NEAREST rather than exact. The stored value is a 0..1 decimal that a dev
   * console command (`/volume 0.35`) or a hand edit can put between two steps,
   * and a strip with nothing lit reads as a broken control. Rounding never
   * WRITES anything, so the odd value survives until the player picks a step.
   */
  private get volumePc(): number {
    const pc = this.prefs.volume * 100;
    let best = VOLUME_STEPS[0];
    for (const s of VOLUME_STEPS) if (Math.abs(s - pc) < Math.abs(best - pc)) best = s;
    return best;
  }

  /**
   * The list, as HTML, for a host to put inside its own container.
   *
   * Returns the ROWS and not a wrapper, so a host decides what surrounds them —
   * the title screen puts them in the same `.bs-opts` column its New Game button
   * lives in, the pause menu in a panel of its own. `.bs-opts` is what carries
   * the shared look (ui/styles.ts); it is deliberately not scoped to either host.
   */
  markup(): string {
    return (
      `<h2>${escapeHtml(t('menu.settings.title'))}</h2>` +
      this.tabStrip() +
      this.rows()
    );
  }

  /**
   * The tab strip. Emitted as a direct child of `.bs-opts` like every row is —
   * that element is the flex column, and a wrapper around the rows below would
   * take them out of it and lose the shared gap.
   */
  private tabStrip(): string {
    return `<div class="tabs">${TABS.map((tb) => {
      const on = tb.id === this.tab;
      return `<button class="bs-menu-btn chip tab${on ? ' on' : ''}" type="button" ` +
        `data-tab="${tb.id}" aria-selected="${on}">${escapeHtml(t(tb.labelKey))}</button>`;
    }).join('')}</div>`;
  }

  /** The rows of whichever tab is showing. */
  private rows(): string {
    const inGame = this.place === 'game';
    switch (this.tab) {
      case 'controls':
        return (
          this.toggle('hapticFeedback', t('menu.settings.hapticFeedback'), this.prefs.hapticFeedback) +
          this.toggle('invertLookX', t('menu.settings.invertX'), this.prefs.invertLookX) +
          this.toggle('invertLookY', t('menu.settings.invertY'), this.prefs.invertLookY) +
          // The note belongs to the two INVERT rows — it says the mouse is never
          // inverted — so anything added below it must go after it, not between.
          `<div class="note">${escapeHtml(t('menu.settings.controllerNote'))}</div>`
        );

      case 'graphics':
        // The live values come from STORAGE rather than from a field, so a row
        // shows what the F3 panel or `/gfx` last set even if that happened while
        // this panel was on screen behind them. See storedGfx in core/gfx.ts.
        return GRAPHICS_ROWS.map((r) =>
          `<button class="bs-menu-btn row" type="button" data-gfx="${r.id}" ` +
          `aria-pressed="${Boolean(storedGfx(r.id))}">` +
          `<span class="lbl">${escapeHtml(t(r.labelKey))}</span>` +
          `<span class="pill">${escapeHtml(storedGfx(r.id) ? t('menu.on') : t('menu.off'))}</span>` +
          `</button>`).join('');

      case 'sound':
        return `<div class="row vol">` +
          `<span class="lbl">${escapeHtml(t('menu.settings.music'))}</span>` +
          `<div class="vols">${VOLUME_STEPS.map((pc) =>
            `<button class="bs-menu-btn chip${pc === this.volumePc ? ' on' : ''}" type="button" ` +
            `data-vol="${pc}">${escapeHtml(pc === 0 ? t('menu.off') : `${pc}`)}</button>`,
          ).join('')}</div></div>`;

      case 'gameplay':
      default:
        return (
          this.toggle('autoFullscreen', t('menu.settings.autoFullscreen'), this.prefs.autoFullscreen) +
          `<div class="row lang${inGame ? ' off' : ''}">` +
            `<span class="lbl">${escapeHtml(t('menu.settings.language'))}</span>` +
            `<div class="langs">${languages().map((l) =>
              `<button class="bs-menu-btn chip${l.code === language() ? ' on' : ''}" type="button" ` +
              `data-lang="${l.code}"${inGame ? ' disabled' : ''}>` +
              `${escapeHtml(l.nativeName)}</button>`).join('')}</div></div>` +
          // Only in-game, and only under the row it explains. A disabled control
          // with no reason beside it is indistinguishable from a broken one.
          (inGame ? `<div class="note">${escapeHtml(t('menu.settings.languageInGame'))}</div>` : '')
        );
    }
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
    const tab = btn.getAttribute('data-tab') as SettingsTab | null;
    if (tab) {
      // A press on the tab you are already on is still OURS — it just has
      // nothing to do. Rebuilding anyway would throw the focus ring off the
      // button under the player's thumb for no change at all.
      if (tab !== this.tab) {
        this.tab = tab;
        this.onRebuild?.(`[data-tab="${tab}"]`);
      }
      return true;
    }

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

    const vol = btn.getAttribute('data-vol');
    if (vol !== null) {
      const pc = Number(vol);
      this.prefs = savePrefs({ volume: pc / 100 });
      this.hooks.onVolume(this.prefs.volume);
      // The chips are rewritten in place for the same reason a toggle's pill is:
      // a rebuild would drop the pad's cursor back to the top of the list while
      // the player is still stepping through the levels. `this` is the chip that
      // was pressed, so the class moves off its siblings and onto it.
      for (const sib of Array.from(btn.parentElement?.children ?? [])) {
        sib.classList.toggle('on', sib === btn);
      }
      return true;
    }

    const gfxId = btn.getAttribute('data-gfx') as keyof GfxSinks | null;
    if (gfxId) {
      // Read the STORE rather than a cached copy, for the reason the markup
      // gives: the F3 panel and `/gfx` write the same keys, and a stale flip
      // would turn a row that is already off back on.
      const on = !storedGfx(gfxId);
      storeGfx(gfxId, on);
      this.hooks.onGraphics(gfxId, on);
      this.pill(btn, on);
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

    this.pill(btn, next);
    return true;
  }

  /**
   * Rewrite one row's state in place rather than asking the host to re-render.
   *
   * A rebuild would drop focus back to the top of the list mid-way through
   * changing things, which on a pad is the cursor jumping out from under your
   * thumb. It is also why a TAB is the one control here that does ask for one:
   * it replaces every row, so there is nothing left to rewrite.
   */
  private pill(btn: HTMLElement, on: boolean): void {
    btn.setAttribute('aria-pressed', String(on));
    const pill = btn.querySelector('.pill');
    if (pill) pill.textContent = on ? t('menu.on') : t('menu.off');
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
