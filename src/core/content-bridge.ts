/**
 * `TownInfo.nameKey` / `NpcInfo.nameKey` / `Enemy.nameKey` are `StringKey`, so a
 * name must be the `{ key }` form of `ContentText`. Inline text is refused and the
 * asset is skipped rather than placed nameless (issue #17).
 */

import type { ContentAsset, Diagnostic } from '../content/types';
import { isKnownTextKey, textKeyOf } from '../content/text';
import type { StringKey } from '../i18n';

const issues: Diagnostic[] = [];

/** Everything the engine could not use. Empty in a healthy build. */
export function contentIssues(): readonly Diagnostic[] {
  return issues;
}

export function clearContentIssues(): void {
  issues.length = 0;
}

export function reportContentIssue(d: Diagnostic): void {
  issues.push(d);
}

/** Name as a `StringKey`, or null + a diagnostic. Re-checks the key: the parser only warns. */
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
