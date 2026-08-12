/**
 * The string table lookup. One function used everywhere; no runtime dependency.
 *
 * WHAT THIS IS
 *
 *   t('hint.skillDen')                        -> 'Press E — Skill Den'
 *   t('toast.enteredZone', { zone: 'Embervale' })
 *   tn('item.shard', 1)                       -> 'Cubloon'
 *   tn('item.shard', 7)                       -> 'Cubloons'
 *
 * `src/i18n/en.ts` is the BASE and the source of truth for every key. Other
 * languages are `src/i18n/<iso639-1>.ts` holding only what they have actually
 * translated; they are registered in LANGUAGES below.
 *
 * FALLBACK is one line (`active[key] ?? en[key]`) and it cannot produce a blank
 * or a raw key: `en` is a total map of `StringKey` by construction — the key
 * type IS `keyof typeof en` — so the fallback always hits. A language that
 * translates four strings renders those four and plays English for the rest.
 *
 * COST. `t(key)` with no vars returns the table's own string: one map lookup,
 * ZERO allocation, safe to call from a per-frame path. `t(key, vars)` builds a
 * new string and must not be called every frame — the HUD guards its DOM writes
 * on change and formats only when something actually changed. Keep it that way.
 *
 * PLURALS are deliberately TWO forms, `.one` and `.other`, chosen per language
 * by the `plural` hook below. That covers English, Swedish, German, Spanish and
 * the rest of the one/other family, and French (which wants `one` for 0 as well)
 * is a three-line hook. It does NOT cover Polish, Russian, Arabic or Welsh,
 * which need three to six forms — that is a KNOWN HOLE, and the extension point
 * is clear: widen `PluralForm` and add the matching key suffixes to `en.ts`. It
 * was not done now because no language in the tree needs it and a CLDR rule set
 * is a bigger thing than this whole module.
 *
 * LANGUAGE SELECTION, in order:
 *   1. `?lang=<code>` — the same URL-override convention the post-processing
 *      knobs and core/flags.ts already use, and the only way a tool or a
 *      screenshot can pin a language. It also PINS: `setLanguage` still switches
 *      the running game, but a reload puts the URL's choice back, which is what
 *      makes a capture reproducible.
 *   2. The stored preference (`Prefs.lang`), written only by picking a language
 *      in the start menu.
 *   3. `navigator.language` ('sv-SE' -> 'sv').
 *   4. 'en'.
 *
 * SWITCHING AT RUNTIME. `setLanguage(code)` swaps the table and fires
 * `onLanguageChange` listeners; the start menu re-renders itself, and the game
 * surfaces that captured a string at CONSTRUCTION time (`HUD.relabel`,
 * `TouchControls.relabel`, and main.ts's load-time hint strings) re-derive
 * theirs from the same event. Everything else already calls `t()` on the way to
 * the DOM each frame and needs nothing.
 *
 * ONE THING CANNOT FOLLOW A LIVE SWITCH: carved signs. A fingerpost arm in
 * world/town-parts.ts is voxel GEOMETRY built once from `t(signKey)` at world
 * creation, so a plank that reads RODBRIAR keeps reading it until the world is
 * rebuilt. That is why the language picker lives in the start menu, before the
 * world the player will walk through has been streamed.
 */
import { en, type StringKey, type Translation } from "./en";
import { sv } from "./sv";
import { loadPrefs, savePrefs } from "../core/prefs";

export type { StringKey, Translation } from "./en";

/** Values a placeholder may be filled with. */
export type Vars = Record<string, string | number>;

type PluralForm = "one" | "other";

interface Language {
  table: Translation;
  /**
   * What this language calls ITSELF, for the picker in the start menu. Always
   * written in the language it names — someone looking for Swedish is looking
   * for "Svenska", and cannot be expected to read the English word for it.
   */
  nativeName: string;
  /** Which form `tn` picks for a count. Default: English/Germanic one-or-other. */
  plural?: (n: number) => PluralForm;
}

/**
 * Every language the game ships. Adding one is a file plus a line here; the
 * table is a few kilobytes of strings, so they are imported statically rather
 * than fetched — there is nothing here worth a network round trip or the
 * "text appears a frame late" bug that comes with one.
 */
const LANGUAGES: Record<string, Language> = {
  en: { table: en, nativeName: "English" },
  sv: { table: sv, nativeName: "Svenska" },
};

const DEFAULT_PLURAL = (n: number): PluralForm => (n === 1 ? "one" : "other");

/** A request ('sv-SE', 'SV') reduced to a table that exists, or null. */
function known(requested: string | null | undefined): string | null {
  if (!requested) {
    return null;
  }
  // ISO 639-1 is the file name, so 'sv-SE' and 'sv' are the same table.
  const c = requested.slice(0, 2).toLowerCase();
  return c in LANGUAGES ? c : null;
}

/** The `?lang=` pin, if there is one. Read on every call — it never changes. */
function urlPin(): string | null {
  try {
    return known(new URLSearchParams(window.location.search).get("lang"));
  } catch {
    return null; // no window (tooling)
  }
}

function resolveCode(): string {
  const pinned = urlPin();
  if (pinned) {
    return pinned;
  }

  let stored: string | null = null;
  try {
    stored = known(loadPrefs().lang);
  } catch {
    /* no storage: fall through */
  }
  if (stored) {
    return stored;
  }

  try {
    const browser = known(navigator.language);
    if (browser) {
      return browser;
    }
  } catch {
    /* no navigator: fall through */
  }

  return "en";
}

let code = resolveCode();
let active: Translation = LANGUAGES[code].table;
let pluralOf = LANGUAGES[code].plural ?? DEFAULT_PLURAL;

/** The ISO 639-1 code actually in use — 'en' when the request was unknown. */
export function language(): string {
  return code;
}

/** Every language the picker may offer, base first, in registration order. */
export function languages(): ReadonlyArray<{ code: string; nativeName: string }> {
  return Object.entries(LANGUAGES).map(([c, l]) => ({ code: c, nativeName: l.nativeName }));
}

/**
 * Listeners fired AFTER the table has been swapped, so a listener that calls
 * `t()` gets the new language. A Set rather than an array: `dispose()` paths
 * unsubscribe, and removing by identity from a Set does not shift the
 * collection out from under an iteration.
 */
type LanguageListener = () => void;
const listeners = new Set<LanguageListener>();

/**
 * Subscribe to language changes. Returns the unsubscribe — call it from the
 * subscriber's own `dispose()`, or a torn-down HUD keeps being relabelled.
 */
export function onLanguageChange(fn: LanguageListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Switch the display language for the running game.
 *
 * Returns false for a language that does not ship, so a caller can tell "no
 * such table" from "already in that language" (which returns true and does
 * nothing — re-selecting the current language must not churn every listener).
 *
 * The choice is PERSISTED, including when `?lang=` is pinning this session. The
 * two do not fight: the pin wins on the next load, so a capture stays
 * reproducible, while the preference is what a player gets when they open the
 * game normally. A listener that throws must not cost the others their
 * notification, so each is called inside its own try.
 */
export function setLanguage(next: string): boolean {
  const c = known(next);
  if (!c) {
    return false;
  }
  if (c === code) {
    return true;
  }

  code = c;
  active = LANGUAGES[c].table;
  pluralOf = LANGUAGES[c].plural ?? DEFAULT_PLURAL;
  savePrefs({ lang: c });

  for (const fn of Array.from(listeners)) {
    try {
      fn();
    } catch (e) {
      console.error("[i18n] language listener failed", e);
    }
  }
  return true;
}

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Substitute `{name}` placeholders. Skipped entirely — no allocation, no regex
 * run — for the overwhelmingly common case of a string with no placeholders.
 */
function format(s: string, vars: Vars): string {
  if (s.indexOf("{") < 0) {
    return s;
  }
  return s.replace(PLACEHOLDER, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/**
 * Look up one display string.
 *
 * `key` is checked against the base table at COMPILE time, so a typo is a build
 * failure and never a blank label in the HUD.
 */
export function t(key: StringKey, vars?: Vars): string {
  const s = active[key] ?? en[key];
  return vars === undefined ? s : format(s, vars);
}

/**
 * Bases that have BOTH a `.one` and a `.other` entry in the table — i.e. the
 * things `tn` may be asked to count. Distributes over the key union (that is
 * what the naked type parameter is for), so `tn('item.shrad', 2)` and
 * `tn('hud.hp', 2)` are both compile errors.
 */
type BaseOf<K, S extends string> = K extends `${infer B}.${S}` ? B : never;
export type PluralKey = BaseOf<StringKey, "one"> & BaseOf<StringKey, "other">;

/**
 * Look up a counted display string: `tn('item.shard', 2)` -> 'Cubloons'.
 *
 * `{n}` is filled with the count, so a table entry can read '{n} Cubloons' in a
 * language that wants the number inside the phrase. Callers that print the
 * number separately (the currency pill, the bag chips) simply leave `{n}` out
 * of the string, and then this allocates nothing.
 */
export function tn(key: PluralKey, count: number, vars?: Vars): string {
  const full = `${key}.${pluralOf(count)}` as StringKey;
  const s = active[full] ?? en[full];
  if (s.indexOf("{") < 0) {
    return s;
  }
  return format(s, vars === undefined ? { n: count } : { n: count, ...vars });
}
