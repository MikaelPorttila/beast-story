import { AUTOSAVE_STEPS, DEFAULT_PREFS, loadPrefs, savePrefs, type Prefs } from '../core/prefs';
import { GFX_OPTIONS, storedGfx, storeGfx, type GfxSinks, type GfxValue } from '../core/gfx';
import { t, language, languages, setLanguage, type StringKey } from '../i18n';
import { fullscreenSurvivesEscape } from './fullscreen';
import type { LookAxes } from '../core/gamepad';

/**
 * The settings list, shared by the title screen and the pause menu. This owns the
 * SETTING; a host owns the SCREEN. Seam: `markup()` and `handleClick()`.
 *
 * `place` matters: language is answerable only before a world exists, because a
 * fingerpost's letters are voxel geometry carved at world creation. In-game the
 * picker is DISABLED with a reason, so both panels keep the same shape.
 *
 * A TAB IS NOT A STORAGE GROUP — the `game.settings.<group>.` prefix was fixed
 * when each setting shipped, and renaming a key resets every player's choice.
 *
 * The graphics rows share core/gfx.ts's model and keys with the F3 panel, but
 * only STORE: the panel runs before the `Gfx` that owns the sinks exists.
 */

export type SettingsPlace = 'title' | 'game';

/** Boolean `Prefs` fields, read and written straight off `data-toggle`. */
type ToggleKey = 'hapticFeedback' | 'invertLookX' | 'invertLookY' | 'autoFullscreen';

export type SettingsTab = 'gameplay' | 'controls' | 'graphics' | 'sound';

/** Display order. Gameplay first: it holds the language row. */
const TABS: ReadonlyArray<{ id: SettingsTab; labelKey: StringKey }> = [
  { id: 'gameplay', labelKey: 'menu.settings.tab.gameplay' },
  { id: 'controls', labelKey: 'menu.settings.tab.controls' },
  { id: 'graphics', labelKey: 'menu.settings.tab.graphics' },
  { id: 'sound', labelKey: 'menu.settings.tab.sound' },
];

/**
 * Seven of core/gfx.ts's eleven: the rest need a measured frame rate beside them
 * or delete the WORLD, not the way it is drawn. Cheapest-to-lose first.
 */
const GRAPHICS_ROWS: ReadonlyArray<{ id: keyof GfxSinks; labelKey: StringKey }> = [
  { id: 'ao', labelKey: 'menu.settings.ao' },
  { id: 'bloom', labelKey: 'menu.settings.bloom' },
  { id: 'aa', labelKey: 'menu.settings.aa' },
  { id: 'shadows', labelKey: 'menu.settings.shadows' },
  { id: 'terrainDistance', labelKey: 'menu.settings.terrainDistance' },
  { id: 'grass', labelKey: 'menu.settings.foliage' },
  { id: 'foliageDistance', labelKey: 'menu.settings.foliageDistance' },
];

function graphicsValueLabel(id: keyof GfxSinks, value: GfxValue): string {
  if (id === 'terrainDistance') {
    return t(value === 480 ? 'gfx.distance.low' : value === 600 ? 'gfx.distance.medium' : 'gfx.distance.high');
  }
  if (id === 'foliageDistance') {
    return t(value === 64 ? 'gfx.distance.low' : value === 96 ? 'gfx.distance.medium' : 'gfx.distance.high');
  }
  return t(value ? 'menu.on' : 'menu.off');
}

function nextGraphicsValue(id: keyof GfxSinks): GfxValue {
  const opt = GFX_OPTIONS.find((o) => o.id === id);
  const value = storedGfx(id);
  if (!opt?.choices) return !value;
  const i = opt.choices.indexOf(Number(value));
  return opt.choices[(i + 1) % opt.choices.length];
}

/**
 * Per cent. Chips, not a slider: pad hosts `.click()` real buttons. Twenties so
 * the default 80 is a step; 0 is OFF and sits outside the strip (`volumeRow`).
 */
const VOLUME_STEPS: ReadonlyArray<number> = [0, 20, 40, 60, 80, 100];

/** Every hook is applied LIVE; this module owns the persisting. */
export interface SettingsHooks {
  onLookAxes: (a: Partial<LookAxes>) => void;
  onHapticFeedback: (on: boolean) => void;
  /** Issue #171. Optional: the title screen has no session to save yet. */
  onAutosaveInterval?: (minutes: number) => void;
  onVolume: (v: number) => void;
  /** Apply only — the value is already stored, so a title-screen call is safe. */
  onGraphics: (id: keyof GfxSinks, value: GfxValue) => void;
}

/**
 * Focus stops for a host's up/down cursor. Not "every button": `[disabled]` is
 * the in-game language chips, `[tabindex="-1"]` the non-current members of a
 * strip (a strip is ONE control), `.sec.off *` the hidden-but-present sections.
 */
export const FOCUSABLE =
  'button:not([disabled]):not([tabindex="-1"]):not(.sec.off *)';

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

export class SettingsPanel {
  private prefs: Prefs;
  /** Remembered for the panel's life, so re-entering lands where you left. */
  private tab: SettingsTab = 'gameplay';

  /**
   * Set by the HOST: markup changed SHAPE, rebuild and put the cursor on `focus`.
   * Only for changes that move focus stops (a tab, a strip's roving tabindex) —
   * a host's `focusables` is built per render.
   */
  onRebuild: ((focus: string) => void) | null = null;

  /** `place` is fixed for the panel's life: a panel belongs to one screen. */
  constructor(readonly place: SettingsPlace, private hooks: SettingsHooks) {
    this.prefs = loadPrefs();
  }

  get values(): Prefs { return this.prefs; }

  /** NEAREST step: `/volume 0.35` lands between two, and nothing lit reads as broken. */
  private get volumePc(): number {
    const pc = this.prefs.volume * 100;
    let best = VOLUME_STEPS[0];
    for (const s of VOLUME_STEPS) if (Math.abs(s - pc) < Math.abs(best - pc)) best = s;
    return best;
  }

  /** The ROWS, not a wrapper: the host decides what surrounds them. */
  markup(): string {
    return (
      `<h2>${escapeHtml(t('menu.settings.title'))}</h2>` +
      this.tabStrip() +
      this.sections()
    );
  }

  /** ONE control, not four buttons: only the tab showing is a focus stop. */
  private tabStrip(): string {
    return `<div class="tabs strip" role="tablist" data-group="tab">${TABS.map((tb) => {
      const on = tb.id === this.tab;
      return `<button class="bs-menu-btn chip tab${on ? ' on' : ''}" type="button" ` +
        `role="tab" data-tab="${tb.id}" aria-selected="${on}"${on ? '' : ' tabindex="-1"'}>` +
        `${escapeHtml(t(tb.labelKey))}</button>`;
    }).join('')}</div>`;
  }

  /**
   * EVERY section, stacked into one grid cell, so the box is as tall as the
   * TALLEST and switching tabs moves nothing. Rendering only the live section made
   * the list jump 111px..327px. Hidden ones are skipped by `FOCUSABLE`.
   */
  private sections(): string {
    const inGame = this.place === 'game';
    // Issue #83: the game never takes a fullscreen the first closed panel gives
    // back, so the row shows OFF plus a reason rather than reading as broken.
    const keepsFull = fullscreenSurvivesEscape();
    return `<div class="rows">` +
      this.section('gameplay',
        this.toggle('autoFullscreen', t('menu.settings.autoFullscreen'),
          this.prefs.autoFullscreen && keepsFull, !keepsFull) +
        (keepsFull ? '' : `<div class="note">${escapeHtml(t('menu.settings.fullscreenEscape'))}</div>`) +
        `<div class="row lang${inGame ? ' off' : ''}">` +
          `<span class="lbl">${escapeHtml(t('menu.settings.language'))}</span>` +
          `<div class="langs strip" data-group="lang">${languages().map((l) => {
            const on = l.code === language();
            return `<button class="bs-menu-btn chip${on ? ' on' : ''}" type="button" ` +
              `data-lang="${l.code}"${inGame ? ' disabled' : ''}${on ? '' : ' tabindex="-1"'}>` +
              `${escapeHtml(l.nativeName)}</button>`;
          }).join('')}</div></div>` +
        // Only in-game, and only under the row it explains.
        (inGame ? `<div class="note">${escapeHtml(t('menu.settings.languageInGame'))}</div>` : '') +
        this.autosaveRow()) +

      this.section('controls',
        this.toggle('hapticFeedback', t('menu.settings.hapticFeedback'), this.prefs.hapticFeedback) +
        this.toggle('invertLookX', t('menu.settings.invertX'), this.prefs.invertLookX) +
        this.toggle('invertLookY', t('menu.settings.invertY'), this.prefs.invertLookY) +
        // The note belongs to the two INVERT rows: add new rows after it, not between.
        `<div class="note">${escapeHtml(t('menu.settings.controllerNote'))}</div>`) +

      // Values read from STORAGE, so a row shows what F3 or `/gfx` last set.
      this.section('graphics', GRAPHICS_ROWS.map((r) =>
        // No aria-pressed on choice rows: Low/Medium/High is a value, not a state.
        `<button class="bs-menu-btn row" type="button" data-gfx="${r.id}" ` +
        `${typeof storedGfx(r.id) === 'boolean' ? `aria-pressed="${Boolean(storedGfx(r.id))}"` : ''}>` +
        `<span class="lbl">${escapeHtml(t(r.labelKey))}</span>` +
        `<span class="pill">${escapeHtml(graphicsValueLabel(r.id, storedGfx(r.id)))}</span>` +
        `</button>`).join('')) +

      this.section('sound', this.volumeRow()) +
    `</div>`;
  }

  private section(id: SettingsTab, inner: string): string {
    return `<div class="sec${id === this.tab ? '' : ' off'}" data-sec="${id}">${inner}</div>`;
  }

  /**
   * Issue #171. Like `volumeRow`: OFF stands outside the strip, which roves from
   * the shipped default. Minutes are in the LABELS, so no chip is a bare number.
   */
  private autosaveRow(): string {
    const now = this.prefs.autosaveMinutes;
    const rove = now === 0 ? DEFAULT_PREFS.autosaveMinutes : now;
    const steps = AUTOSAVE_STEPS.slice(1);
    return `<div class="row vol">` +
      `<span class="lbl">${escapeHtml(t('menu.settings.autosave'))}</span>` +
      `<div class="vols">` +
        `<button class="bs-menu-btn chip mute${now === 0 ? ' on' : ''}" type="button" ` +
          `data-autosave="0">${escapeHtml(t('menu.off'))}</button>` +
        `<div class="steps strip" data-group="autosave">${steps.map((m) =>
          `<button class="bs-menu-btn chip${m === now ? ' on' : ''}" type="button" ` +
          `data-autosave="${m}"${m === rove ? '' : ' tabindex="-1"'}>` +
          `${escapeHtml(t('menu.settings.autosave.minutes', { n: String(m) }))}</button>`).join('')}</div>` +
      `</div></div>`;
  }

  private setAutosave(minutes: number): void {
    this.prefs = savePrefs({ autosaveMinutes: minutes });
    this.hooks.onAutosaveInterval?.(this.prefs.autosaveMinutes);
    this.onRebuild?.(`[data-autosave="${minutes}"]`);
  }

  /** Mute is its own button, not the strip's first step: OFF is not "quieter". */
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

  /** Returns whether the click was ours. Takes the host's already-resolved button. */
  handleClick(btn: HTMLElement): boolean {
    const tab = btn.getAttribute('data-tab') as SettingsTab | null;
    if (tab) {
      // The current tab is still OURS, but rebuilding would drop the focus ring.
      if (tab !== this.tab) this.showTab(tab);
      return true;
    }

    const lang = btn.getAttribute('data-lang');
    if (lang) {
      // Unreachable in-game (chips are `disabled`), but markup is not a guard.
      if (this.place === 'game') return true;
      // The re-render comes from the language event; the picker is just a listener.
      setLanguage(lang);
      return true;
    }

    const vol = btn.getAttribute('data-vol');
    if (vol !== null) {
      this.setVolume(Number(vol));
      return true;
    }

    const autosave = btn.getAttribute('data-autosave');
    if (autosave !== null) {
      this.setAutosave(Number(autosave));
      return true;
    }

    const gfxId = btn.getAttribute('data-gfx') as keyof GfxSinks | null;
    if (gfxId) {
      // Read the STORE, not a cached copy: the F3 panel and `/gfx` write the same
      // keys, and a stale flip would turn an already-off row back on.
      const value = nextGraphicsValue(gfxId);
      storeGfx(gfxId, value);
      this.hooks.onGraphics(gfxId, value);
      if (typeof value === 'boolean') this.pill(btn, value);
      else {
        btn.querySelector('.pill')!.textContent = graphicsValueLabel(gfxId, value);
      }
      return true;
    }

    const toggle = btn.getAttribute('data-toggle') as ToggleKey | null;
    if (!toggle) return false;

    const next = !this.prefs[toggle];
    this.prefs = savePrefs({ [toggle]: next });
    if (toggle === 'hapticFeedback') this.hooks.onHapticFeedback(next);
    else if (toggle === 'invertLookX') this.hooks.onLookAxes({ invertX: next });
    else if (toggle === 'invertLookY') this.hooks.onLookAxes({ invertY: next });
    // `autoFullscreen` has no hook: it is read when New Game is pressed.

    this.pill(btn, next);
    return true;
  }

  /**
   * LEFT/RIGHT changes the strip's VALUE; returns whether the key was ours.
   * Wrapping is per strip: tabs and languages RING, volume and autosave CLAMP.
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
        // A guard rather than a promise, as in `handleClick`.
        if (this.place === 'game') return true;
        const codes = languages().map((l) => l.code);
        const i = Math.max(0, codes.indexOf(language()));
        setLanguage(codes[(i + dir + codes.length) % codes.length]);
        return true;
      }
      case 'autosave': {
        const steps = AUTOSAVE_STEPS.slice(1);
        const here = this.prefs.autosaveMinutes === 0
          ? 0 : steps.indexOf(this.prefs.autosaveMinutes);
        this.setAutosave(steps[Math.min(steps.length - 1, Math.max(0, here + dir))]);
        return true;
      }
      case 'vol': {
        const steps = VOLUME_STEPS.slice(1);
        // From MUTE the strip starts quietest, so either direction is a way out.
        const here = this.volumePc === 0 ? 0 : steps.indexOf(this.volumePc);
        this.setVolume(steps[Math.min(steps.length - 1, Math.max(0, here + dir))]);
        return true;
      }
      default:
        return false;
    }
  }

  private showTab(tab: SettingsTab): void {
    this.tab = tab;
    this.onRebuild?.(`[data-tab="${tab}"]`);
  }

  /** Takes 0..100. Rebuilds, because the roving tabindex moves with the value. */
  private setVolume(pc: number): void {
    this.prefs = savePrefs({ volume: pc / 100 });
    this.hooks.onVolume(this.prefs.volume);
    this.onRebuild?.(`[data-vol="${pc}"]`);
  }

  /** In place, not a rebuild: a row that changes only its own pill keeps focus. */
  private pill(btn: HTMLElement, on: boolean): void {
    btn.setAttribute('aria-pressed', String(on));
    const pill = btn.querySelector('.pill');
    if (pill) pill.textContent = on ? t('menu.on') : t('menu.off');
  }

  /**
   * The row IS the button, not a checkbox: pad hosts drive by `.click()`.
   * `disabled` is the attribute, not a class, because `FOCUSABLE` excludes it.
   */
  private toggle(key: ToggleKey, label: string, on: boolean, disabled = false): string {
    return `<button class="bs-menu-btn row" type="button" data-toggle="${key}" ` +
      `${disabled ? 'disabled ' : ''}aria-pressed="${on}"><span class="lbl">${escapeHtml(label)}</span>` +
      `<span class="pill">${escapeHtml(on ? t('menu.on') : t('menu.off'))}</span></button>`;
  }
}
