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
 *      screenshot can pin a language.
 *   2. `navigator.language` ('sv-SE' -> 'sv').
 *   3. 'en'.
 * Resolved ONCE at module load. There is no live language switch: every caller
 * would have to re-render, and a page reload with `?lang=` is the whole feature
 * for a tenth of the machinery.
 */
import { en, type StringKey, type Translation } from './en';
import { sv } from './sv';

export type { StringKey, Translation } from './en';

/** Values a placeholder may be filled with. */
export type Vars = Record<string, string | number>;

type PluralForm = 'one' | 'other';

interface Language {
  table: Translation;
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
  en: { table: en },
  sv: { table: sv },
};

const DEFAULT_PLURAL = (n: number): PluralForm => (n === 1 ? 'one' : 'other');

function resolveCode(): string {
  let requested: string | null = null;
  try {
    requested = new URLSearchParams(window.location.search).get('lang');
  } catch { /* no window (tooling): fall through */ }
  if (!requested) {
    try {
      requested = navigator.language;
    } catch { /* no navigator: fall through */ }
  }
  // ISO 639-1 is the file name, so 'sv-SE' and 'sv' are the same table.
  const code = (requested ?? 'en').slice(0, 2).toLowerCase();
  return code in LANGUAGES ? code : 'en';
}

const code = resolveCode();
const active: Translation = LANGUAGES[code].table;
const pluralOf = LANGUAGES[code].plural ?? DEFAULT_PLURAL;

/** The ISO 639-1 code actually in use — 'en' when the request was unknown. */
export function language(): string {
  return code;
}

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Substitute `{name}` placeholders. Skipped entirely — no allocation, no regex
 * run — for the overwhelmingly common case of a string with no placeholders.
 */
function format(s: string, vars: Vars): string {
  if (s.indexOf('{') < 0) return s;
  return s.replace(PLACEHOLDER, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole);
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
export type PluralKey = BaseOf<StringKey, 'one'> & BaseOf<StringKey, 'other'>;

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
  if (s.indexOf('{') < 0) return s;
  return format(s, vars === undefined ? { n: count } : { n: count, ...vars });
}
