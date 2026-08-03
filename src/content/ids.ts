/**
 * Content identifiers: the one place `"<type>:<name>"` is spelled.
 *
 * Every id in the system arrives from untrusted JSON, so the format is enforced
 * HERE — at the boundary where the data lands — rather than in a type that a
 * cast could defeat. See the long note on `ContentId` in content/types.ts for
 * why the type is inside the id and the package is not.
 *
 * THE GRAMMAR IS DELIBERATELY NARROW. `type` and `name` are lower-case
 * `[a-z0-9-]`, and `name` may contain `/` to group (`quest:encampment/first-
 * steps`). Narrow because these strings end up in save games, in file names, in
 * URLs for remote packages and in log lines: anything that would need escaping
 * in one of those is not worth the freedom. Upper case is excluded rather than
 * folded, so two ids can never differ only by case on a case-insensitive
 * filesystem and agree on a case-sensitive one.
 */

import type { ContentId, ContentTypeName, PackageId } from './types';

/** `type` and `name` between the single colon. Anchored: no leading/trailing junk. */
const ID_RE = /^([a-z][a-z0-9-]*):([a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*)$/;

/** A package id: the same alphabet, no colon and no slash. */
const PKG_RE = /^[a-z][a-z0-9-]*$/;

export interface ParsedId {
  readonly type: ContentTypeName;
  readonly name: string;
}

/** Split an id, or null when it is not one. Never throws — callers report. */
export function parseId(value: unknown): ParsedId | null {
  if (typeof value !== 'string') return null;
  const m = ID_RE.exec(value);
  return m ? { type: m[1], name: m[2] } : null;
}

/** True when `value` is a well-formed id. */
export function isId(value: unknown): value is ContentId {
  return parseId(value) !== null;
}

/** True when `value` is a well-formed id of exactly `type`. */
export function isIdOf(value: unknown, type: ContentTypeName): value is ContentId {
  const p = parseId(value);
  return p !== null && p.type === type;
}

/** The `type` half, or null. */
export function typeOf(id: ContentId): ContentTypeName | null {
  return parseId(id)?.type ?? null;
}

/** The `name` half, or null. */
export function nameOf(id: ContentId): string | null {
  return parseId(id)?.name ?? null;
}

/** Build an id. Throws on a malformed pair — this one is called by our own code. */
export function makeId(type: ContentTypeName, name: string): ContentId {
  const id = `${type}:${name}`;
  if (!isId(id)) throw new Error(`content: malformed id "${id}"`);
  return id;
}

export function isPackageId(value: unknown): value is PackageId {
  return typeof value === 'string' && PKG_RE.test(value);
}

/**
 * Sort key that groups by type and then orders by name.
 *
 * Diagnostics, `__dbgContent()` and any listing go through this, because a
 * stable order is what makes two runs of a probe comparable — a Map's insertion
 * order is load order, and load order changes the moment a package is split.
 */
export function compareIds(a: ContentId, b: ContentId): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
