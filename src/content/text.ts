// Reads both ContentText shapes. Invariant (issue #17): never return the empty
// string — always words, the caller's fallback, or a bracketed id.

import { en } from "../i18n/en";
import { language, t } from "../i18n";
import type { StringKey } from "../i18n";
import type { ContentText } from "./types";

// Runtime stand-in for the `StringKey` compile-time check: schema.ts and
// validate.ts import no string tables, so callers inject this.
export function isKnownTextKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(en, key);
}

export function textKeyOf(text: ContentText | undefined): StringKey | undefined {
  if (text === undefined || !("key" in text)) {
    return undefined;
  }
  return text.key;
}

// False for a key the table lacks, so a caller does not render a placeholder as content.
export function hasText(text: ContentText | undefined): boolean {
  if (text === undefined) {
    return false;
  }
  if ("key" in text) {
    return isKnownTextKey(text.key);
  }
  return Object.values(text.text).some((s) => typeof s === "string" && s.trim() !== "");
}

// Pass the asset's own bracketed id as `fallback` so a bad label names itself.
// Allocation-free on the hit paths, so it is safe per frame.
export function resolveText(text: ContentText | undefined, fallback?: string): string {
  if (text === undefined) {
    return fallback ?? "[no text]";
  }

  if ("key" in text) {
    // A key from JSON may not be in the table; check here or the DOM shows "undefined".
    if (isKnownTextKey(text.key)) {
      return t(text.key);
    }
    return fallback ?? `[${text.key}]`;
  }

  const table = text.text;
  const active = table[language()];
  if (typeof active === "string" && active.trim() !== "") {
    return active;
  }
  // English second: the base table's language, so most likely to be filled in.
  const base = table.en;
  if (typeof base === "string" && base.trim() !== "") {
    return base;
  }
  for (const value of Object.values(table)) {
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return fallback ?? "[text]";
}
