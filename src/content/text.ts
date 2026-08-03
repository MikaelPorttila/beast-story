/**
 * TURNING A `ContentText` INTO WORDS — the one place either of its two shapes is
 * read (content/types.ts says so of both).
 *
 * THE TWO FORMS EXIST BECAUSE ONE COMPILE-TIME GUARANTEE CANNOT COVER BOTH HALVES
 * OF THE PROBLEM. `StringKey` is `keyof typeof en`, so every string authored
 * INSIDE this repository is checked against the base table at build time and a
 * typo is a build failure rather than a blank label. Data authored OUTSIDE the
 * build — a remote pack, a quest written by a tool — cannot have been checked
 * against the table this build shipped, so it carries its words with it instead.
 * So:
 *
 *   { "key": "town.encampment.name" }        -> `t()`, and follows a live switch
 *   { "text": { "en": "…", "sv": "…" } }     -> picked here, by the same rule
 *
 * THE KEY FORM GOES THROUGH `t()`, WHICH IS THE WHOLE POINT OF IT. i18n's rule is
 * that a string looked up on its way to the DOM is free and follows
 * `setLanguage` with no further wiring; anything that captures one at
 * construction owes it a re-derive. Resolving a content name through `t()` puts
 * every migrated town, NPC and enemy on the free side of that line — the language
 * picker re-labels them along with everything else, and nothing in `src/i18n/`
 * had to change to make it so.
 *
 * THE INLINE FORM DUPLICATES i18n's PRECEDENCE, AND SAYS SO. `index.ts` resolves
 * the active code once (URL pin, stored preference, `navigator.language`, `en`)
 * and exposes it as `language()`; that is what is read below, so the ACTIVE code
 * is never guessed here. What is repeated is the FALLBACK order — active, then
 * `en`, then whatever there is — because `t()`'s own fallback is a lookup in the
 * shipped tables and there is nothing for it to look this up in. Two rules that
 * must agree, so the second one is written next to the first: any language, then
 * English, then the first entry with words in it, and never a blank.
 *
 * NEVER THE EMPTY STRING. That is the rule the whole file is built around, and it
 * is issue #17's lesson from the other end: a blank label in the HUD is a defect
 * you cannot see — it reads as a rendering bug, or as nothing at all — where a
 * bracketed id is one that names itself and the asset to open. So every path out
 * of `resolveText` ends in words, a caller's fallback, or `[something]`.
 */

import { en } from '../i18n/en';
import { language, t } from '../i18n';
import type { StringKey } from '../i18n';
import type { ContentText } from './types';

/**
 * Is this a key the shipped table has?
 *
 * The runtime stand-in for the compile-time check `StringKey` makes, and what
 * `Reader.knownTextKey` (schema.ts) and `ValidateOptions.knownTextKey`
 * (validate.ts) both want: those modules deliberately do not import the string
 * tables, so the caller that can see them supplies this. Every content type's
 * parser passes it, which is what turns "the key form carries one unverifiable
 * claim" into a claim that IS verified for anything this build loads.
 */
export function isKnownTextKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(en, key);
}

/** The `StringKey` when the value is the key form, else undefined. */
export function textKeyOf(text: ContentText | undefined): StringKey | undefined {
  if (text === undefined || !('key' in text)) return undefined;
  return text.key;
}

/**
 * True when this text can produce words — the test a caller makes before
 * deciding whether to show a row at all.
 *
 * A `key` the table does not have is FALSE here, deliberately: the asset claims
 * a string that does not exist, and answering true would send a caller off to
 * render the placeholder as though it were content.
 */
export function hasText(text: ContentText | undefined): boolean {
  if (text === undefined) return false;
  if ('key' in text) return isKnownTextKey(text.key);
  return Object.values(text.text).some((s) => typeof s === 'string' && s.trim() !== '');
}

/**
 * The words, for the language in use now.
 *
 * `fallback` is what a caller shows when the text is absent or unusable, and the
 * shape the game should pass is the ASSET'S OWN ID in brackets —
 * `resolveText(asset.name, `[${asset.id}]`)`. That is a label a screenshot can be
 * read from and a diagnostic can be grepped for, which is the whole argument
 * above. With no fallback the result still names what it could: the key that
 * missed, or `[text]` for an inline entry with nothing in it.
 *
 * ALLOCATION: the key form with a real key returns the table's own string and
 * allocates nothing, so this is safe on a per-frame path exactly as `t(key)` is.
 * The inline form is a lookup in a small record. Neither builds a string unless
 * it is producing a placeholder, which is a bug being reported and not a frame.
 */
export function resolveText(text: ContentText | undefined, fallback?: string): string {
  if (text === undefined) return fallback ?? '[no text]';

  if ('key' in text) {
    // `t()` is typed to return a string, and does for every key the table has.
    // A key that arrived from JSON may not be one of those — the type assertion
    // that let it in is named in schema.ts — so the miss is checked for HERE
    // rather than allowed to reach the DOM as the string "undefined".
    if (isKnownTextKey(text.key)) return t(text.key);
    return fallback ?? `[${text.key}]`;
  }

  const table = text.text;
  const active = table[language()];
  if (typeof active === 'string' && active.trim() !== '') return active;
  // English second. Not because English is special to the player, but because it
  // is the base table's language and therefore the one an author is most likely
  // to have filled in — the same reason `t()` falls back to `en`.
  const base = table.en;
  if (typeof base === 'string' && base.trim() !== '') return base;
  for (const value of Object.values(table)) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return fallback ?? '[text]';
}
