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
 * EVERY section is in the DOM at once and the hidden ones are hidden rather than
 * absent, which is what keeps the panel's height from moving as a player steps
 * along the strip — see `sections`. And every STRIP on it (the tabs, the volume
 * levels, the languages) is ONE control rather than N buttons — see `stepGroup`
 * and `FOCUSABLE`, which are the two halves of that.
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
 *
 * IT IS ALSO THE ONE STEP THAT IS NOT PART OF THE STRIP. The levels are a single
 * control a player sweeps with left/right; mute is a decision, and folding it in
 * would put it one nudge past 20 on a control being swept. See `volumeRow`.
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
 * What counts as a stop for a host's own up/down cursor, as a selector.
 *
 * Exported because it is a fact about this panel's markup and both hosts need
 * exactly the same answer — and because it stopped being "every button" the day
 * the panel grew STRIPS and stacked sections. Three clauses, one reason each:
 *
 *   - `[disabled]`: the language chips in game.
 *   - `[tabindex="-1"]`: the members of a strip that are not its current value.
 *     A strip is ONE control (see `stepGroup`), so only the value showing is a
 *     stop; left/right changes it. This is the roving-tabindex pattern, and
 *     taking the others out of the browser's own Tab order is the half a host
 *     cannot do for itself.
 *   - `.sec.off *`: every section that is not the tab showing. They are in the
 *     DOM — that is what makes the panel's height constant, see `sections` —
 *     and `visibility:hidden` already keeps the browser from focusing them, but
 *     `querySelectorAll` sees them and a pad cursor would walk into a section
 *     nobody can see.
 */
export const FOCUSABLE =
  'button:not([disabled]):not([tabindex="-1"]):not(.sec.off *)';

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
   * The two callers are a TAB and a VOLUME STEP, and what they have in common is
   * that both change which elements are focus stops — a tab lights a different
   * section, a step moves the roving tabindex along the strip. A host builds its
   * `focusables` list once per render, so neither can be patched in place the way
   * a toggle's pill is. The host owns focus (see the `pendingFocus` note in
   * either of them), so the host is asked to render; the selector is what stops
   * the cursor jumping off the control the player is still using. It is the same
   * path a language change already takes.
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
      this.sections()
    );
  }

  /**
   * The tab strip: ONE control, not four buttons.
   *
   * A pad player should reach the settings in one step down, not five, and once
   * they are on the strip left/right should MOVE THROUGH THE SECTIONS rather
   * than through the buttons that name them. So only the tab showing is a stop
   * (`stepGroup` and `FOCUSABLE` are the two halves of that) — which is also
   * what a keyboard user gets from Tab, since `tabindex="-1"` takes the rest out
   * of the browser's own order.
   */
  private tabStrip(): string {
    return `<div class="tabs strip" role="tablist" data-group="tab">${TABS.map((tb) => {
      const on = tb.id === this.tab;
      return `<button class="bs-menu-btn chip tab${on ? ' on' : ''}" type="button" ` +
        `role="tab" data-tab="${tb.id}" aria-selected="${on}"${on ? '' : ' tabindex="-1"'}>` +
        `${escapeHtml(t(tb.labelKey))}</button>`;
    }).join('')}</div>`;
  }

  /**
   * EVERY section, stacked — and that is what makes the panel's height constant.
   *
   * They are laid one on top of another in a single grid cell (see `.bs-opts
   * .rows` in ui/styles.ts), so the box is as tall as the TALLEST section and
   * swapping tabs changes nothing about the layout around it. The panel used to
   * render only the section showing, and the list jumped between 111px and 327px
   * as the player stepped along the strip — with the Back button under their
   * cursor moving each time, which on a pad is the control you are aiming at
   * walking away from you.
   *
   * The alternative was a fixed pixel height per screen band, and it is worse in
   * the way this file has been bitten before: a number written down here has to
   * be re-measured every time a row is added or a translation makes one wrap,
   * and nothing fails when it is not. Stacking asks the browser instead.
   *
   * The cost is that three sections a player cannot see are in the DOM. They are
   * `visibility:hidden`, so they cannot be clicked, cannot be focused by the
   * browser, and are skipped by `FOCUSABLE` — which is the clause a host would
   * otherwise have to know about.
   */
  private sections(): string {
    const inGame = this.place === 'game';
    return `<div class="rows">` +
      this.section('gameplay',
        this.toggle('autoFullscreen', t('menu.settings.autoFullscreen'), this.prefs.autoFullscreen) +
        `<div class="row lang${inGame ? ' off' : ''}">` +
          `<span class="lbl">${escapeHtml(t('menu.settings.language'))}</span>` +
          `<div class="langs strip" data-group="lang">${languages().map((l) => {
            const on = l.code === language();
            return `<button class="bs-menu-btn chip${on ? ' on' : ''}" type="button" ` +
              `data-lang="${l.code}"${inGame ? ' disabled' : ''}${on ? '' : ' tabindex="-1"'}>` +
              `${escapeHtml(l.nativeName)}</button>`;
          }).join('')}</div></div>` +
        // Only in-game, and only under the row it explains. A disabled control
        // with no reason beside it is indistinguishable from a broken one.
        (inGame ? `<div class="note">${escapeHtml(t('menu.settings.languageInGame'))}</div>` : '')) +

      this.section('controls',
        this.toggle('hapticFeedback', t('menu.settings.hapticFeedback'), this.prefs.hapticFeedback) +
        this.toggle('invertLookX', t('menu.settings.invertX'), this.prefs.invertLookX) +
        this.toggle('invertLookY', t('menu.settings.invertY'), this.prefs.invertLookY) +
        // The note belongs to the two INVERT rows — it says the mouse is never
        // inverted — so anything added below it must go after it, not between.
        `<div class="note">${escapeHtml(t('menu.settings.controllerNote'))}</div>`) +

      // The live values come from STORAGE rather than from a field, so a row
      // shows what the F3 panel or `/gfx` last set even if that happened while
      // this panel was on screen behind them. See storedGfx in core/gfx.ts.
      this.section('graphics', GRAPHICS_ROWS.map((r) =>
        `<button class="bs-menu-btn row" type="button" data-gfx="${r.id}" ` +
        `aria-pressed="${Boolean(storedGfx(r.id))}">` +
        `<span class="lbl">${escapeHtml(t(r.labelKey))}</span>` +
        `<span class="pill">${escapeHtml(storedGfx(r.id) ? t('menu.on') : t('menu.off'))}</span>` +
        `</button>`).join('')) +

      this.section('sound', this.volumeRow()) +
    `</div>`;
  }

  /** One stacked section, lit or hidden. See `sections`. */
  private section(id: SettingsTab, inner: string): string {
    return `<div class="sec${id === this.tab ? '' : ' off'}" data-sec="${id}">${inner}</div>`;
  }

  /**
   * The music row: a MUTE button, and the levels as one control beside it.
   *
   * Two controls rather than one, and the split is not cosmetic. "Quieter" is a
   * direction — left and right along a scale, which is what a strip is for — and
   * OFF is not a quieter level, it is the feature switched off (nothing is
   * fetched and whatever was playing is unloaded; see core/prefs.ts). Folding it
   * into the same strip would put mute one nudge past 20 on a control the player
   * is sweeping, and would make "turn the music off" a thing you arrive at by
   * accident rather than press.
   *
   * The strip's stop is the level SHOWING. While the volume is 0 nothing in it
   * is lit and the stop is the nearest step to what is stored, which for a muted
   * profile is the quietest — so a player who muted and came back leaves mute in
   * the direction they push, whichever it is.
   */
  private volumeRow(): string {
    const pc = this.volumePc;
    const rove = pc === 0 ? VOLUME_STEPS[1] : pc;
    return `<div class="row vol">` +
      `<span class="lbl">${escapeHtml(t('menu.settings.music'))}</span>` +
      `<div class="vols">` +
        `<button class="bs-menu-btn chip mute${pc === 0 ? ' on' : ''}" type="button" ` +
          `data-vol="0">${escapeHtml(t('menu.off'))}</button>` +
        `<div class="steps strip" data-group="vol">${VOLUME_STEPS.slice(1).map((s) =>
          `<button class="bs-menu-btn chip${s === pc ? ' on' : ''}" type="button" ` +
          `data-vol="${s}"${s === rove ? '' : ' tabindex="-1"'}>${s}</button>`).join('')}</div>` +
      `</div></div>`;
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
      if (tab !== this.tab) this.showTab(tab);
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
      this.setVolume(Number(vol));
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
   * LEFT or RIGHT on whatever the cursor is standing on. Returns whether it was
   * one of this panel's strips, so a host knows whether to spend the key.
   *
   * This is the other half of "a strip is ONE control". The hosts used to nudge
   * the FOCUS along a strip and leave the player to press A on the chip they
   * landed on — two presses to change a value that is a direction, and, for the
   * tabs, four presses to walk past a section they did not want. Here the
   * direction IS the change: the tab switches, the volume moves, the language
   * changes, and the cursor stays on the control.
   *
   * WRAPPING IS PER STRIP, and the difference is what the ends mean. The tabs
   * and the languages are a RING — there is no first or last section, and coming
   * off the end of four tabs onto the first is how every tablist behaves. The
   * volume is a SCALE, so it clamps: one nudge past 100 landing on 20 is a thing
   * no player wants and every player would do by accident.
   */
  stepGroup(el: Element | null, dir: -1 | 1): boolean {
    const strip = el?.closest?.('.strip') as HTMLElement | null;
    if (!strip) return false;
    switch (strip.getAttribute('data-group')) {
      case 'tab': {
        const i = TABS.findIndex((tb) => tb.id === this.tab);
        this.showTab(TABS[(i + dir + TABS.length) % TABS.length].id);
        return true;
      }
      case 'lang': {
        // Disabled in game, and the strip is not reachable there — but a guard
        // rather than a promise, the same way `handleClick` checks it.
        if (this.place === 'game') return true;
        const codes = languages().map((l) => l.code);
        const i = Math.max(0, codes.indexOf(language()));
        setLanguage(codes[(i + dir + codes.length) % codes.length]);
        return true;
      }
      case 'vol': {
        const steps = VOLUME_STEPS.slice(1);
        // From MUTE the strip starts at its quietest step, so a nudge in either
        // direction is a way out of it. See `volumeRow`.
        const here = this.volumePc === 0 ? 0 : steps.indexOf(this.volumePc);
        this.setVolume(steps[Math.min(steps.length - 1, Math.max(0, here + dir))]);
        return true;
      }
      default:
        return false;
    }
  }

  /** Show a section, and tell the host so it can rebuild around the new rows. */
  private showTab(tab: SettingsTab): void {
    this.tab = tab;
    this.onRebuild?.(`[data-tab="${tab}"]`);
  }

  /**
   * Set the music volume from a step, 0..100, and rebuild.
   *
   * A REBUILD rather than the in-place class swap this used to do, and the
   * reason is the roving tabindex: which chip is a focus stop moved with the
   * value, and a host's `focusables` list is built once per render. Patching the
   * classes alone would leave that list pointing at a button the player can no
   * longer reach. The selector hands the cursor straight back to the chip that
   * now carries the value, so a pad sweeping the strip sees no jump.
   */
  private setVolume(pc: number): void {
    this.prefs = savePrefs({ volume: pc / 100 });
    this.hooks.onVolume(this.prefs.volume);
    this.onRebuild?.(`[data-vol="${pc}"]`);
  }

  /**
   * Rewrite one row's state in place rather than asking the host to re-render.
   *
   * A rebuild would drop focus back to the top of the list mid-way through
   * changing things, which on a pad is the cursor jumping out from under your
   * thumb — so a row that only changes its own pill patches its own pill. The
   * two controls that DO ask for a rebuild both change which elements are focus
   * stops (a tab lights a different section, a volume step moves the roving
   * tabindex), which is precisely what a host's cached list cannot survive.
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
