// Grammar is narrow on purpose: ids land in saves, file names, URLs and logs.
// Lower-case only (not folded), so no two ids collide on a case-insensitive FS.

import type { ContentId, ContentTypeName, PackageId } from './types';

const ID_RE = /^([a-z][a-z0-9-]*):([a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*)$/;

const PKG_RE = /^[a-z][a-z0-9-]*$/;

export interface ParsedId {
  readonly type: ContentTypeName;
  readonly name: string;
}

/** Never throws — callers report. */
export function parseId(value: unknown): ParsedId | null {
  if (typeof value !== 'string') return null;
  const m = ID_RE.exec(value);
  return m ? { type: m[1], name: m[2] } : null;
}

export function isId(value: unknown): value is ContentId {
  return parseId(value) !== null;
}

export function isIdOf(value: unknown, type: ContentTypeName): value is ContentId {
  const p = parseId(value);
  return p !== null && p.type === type;
}

export function typeOf(id: ContentId): ContentTypeName | null {
  return parseId(id)?.type ?? null;
}

export function nameOf(id: ContentId): string | null {
  return parseId(id)?.name ?? null;
}

/** Throws: only our own code calls this. */
export function makeId(type: ContentTypeName, name: string): ContentId {
  const id = `${type}:${name}`;
  if (!isId(id)) throw new Error(`content: malformed id "${id}"`);
  return id;
}

export function isPackageId(value: unknown): value is PackageId {
  return typeof value === 'string' && PKG_RE.test(value);
}

// Listings sort through this: Map insertion order is load order, so it is not stable.
export function compareIds(a: ContentId, b: ContentId): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
