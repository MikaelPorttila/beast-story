/**
 * WHERE CONTENT MEETS `StringKey` — the one narrow place the two halves of
 * `ContentText` are not interchangeable, and what the engine does about it.
 *
 * A `ContentText` (src/content/types.ts) is either `{ key }` into the shipped
 * string table or `{ text: { en: … } }` carried inline by data authored outside
 * this build. `resolveText()` turns both into words, and everything the game
 * merely PRINTS goes through it — a dialogue line, a fingerpost's letters.
 *
 * THREE CONTRACTS IN `core/types.ts` ASK FOR MORE THAN WORDS. `TownInfo.nameKey`,
 * `NpcInfo.nameKey` and `Enemy.nameKey` are typed `StringKey`, which is
 * `keyof typeof en` — the one BUILD-TIME guarantee the whole i18n design rests
 * on (AGENTS.md, Strings). Loosening those three to `ContentText` to admit
 * inline text would spend that guarantee everywhere to buy a case no shipped
 * content has: the migrated core package uses the `{ key }` form throughout.
 *
 * SO THE ENGINE REQUIRES THE KEY FORM FOR A NAME, AND SAYS SO WHEN IT DOES NOT
 * GET ONE. `displayKey` returns the key or null; the three placers above SKIP an
 * asset it refuses rather than inventing a key, standing a nameless town in the
 * world, or printing the string "undefined" in the HUD. A settlement whose name
 * this build cannot print is issue #17's blank label from the other end — a
 * defect a screenshot cannot tell from a rendering bug — and refusing to site it
 * is the failure that names itself. It is reported here, surfaced by
 * `__dbgContent()` in main.ts beside the content runtime's own findings, and it
 * cannot happen for anything in `content/data/core.json`.
 *
 * The list is a MEASUREMENT rather than state: nothing in the game reads it, it
 * is written once per asset at world creation, and it is empty in a healthy
 * build.
 */

import type { ContentAsset, Diagnostic } from '../content/types';
import { isKnownTextKey, textKeyOf } from '../content/text';
import type { StringKey } from '../i18n';

const issues: Diagnostic[] = [];

/** Everything the engine could not use. Empty in a healthy build. */
export function contentIssues(): readonly Diagnostic[] {
  return issues;
}

/** Cleared only by a test that wants to re-run a placement in one page. */
export function clearContentIssues(): void {
  issues.length = 0;
}

/** Record an engine-side finding about a piece of content. */
export function reportContentIssue(d: Diagnostic): void {
  issues.push(d);
}

/**
 * The asset's display name as a `StringKey`, or null with a diagnostic filed.
 *
 * `isKnownTextKey` is asked even though the content type's parser already
 * checked it: the parser's check is a diagnostic, not a refusal — an asset with
 * an unknown key still loads — and `t()` on a key the table does not have
 * renders the string "undefined". Two readers, one rule, and this is the one
 * that decides whether the thing gets built.
 */
export function displayKey(asset: ContentAsset<unknown>): StringKey | null {
  const key = textKeyOf(asset.name);
  if (key !== undefined && isKnownTextKey(key)) return key;
  issues.push({
    severity: 'error',
    code: 'name-not-a-key',
    message: asset.name === undefined
      ? `"${asset.id}" has no name, so nothing can be placed for it`
      : `"${asset.id}" carries its name inline; this build needs a string-table key`,
    assetId: asset.id,
    assetType: asset.type,
    pkg: asset.pkg,
    source: asset.source,
    field: 'name',
    fix: 'write { "key": "…" } against a key in src/i18n/en.ts',
  });
  return null;
}
