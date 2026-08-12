// Reverse edges are recorded even for targets nothing defines yet, so answers do
// not depend on load order and `dangling()` can exist at all.
// Only link/unlink touch `defined`, so it cannot drift from the registry's map.

import { compareIds, typeOf } from './ids';
import type { ContentId, ContentTypeName } from './types';

/** Shared, so a miss on a hot read allocates nothing. */
const NO_IDS: readonly ContentId[] = Object.freeze([]);

export class ContentGraph {
  /** id -> ids it points at. Frozen, deduped, sorted. */
  private readonly forward = new Map<ContentId, readonly ContentId[]>();
  /** id -> ids pointing at it. Present for undefined targets too. */
  private readonly reverse = new Map<ContentId, Set<ContentId>>();
  private readonly defined = new Set<ContentId>();
  /** Referenced, undefined. Kept incrementally so `dangling()` is not O(edges). */
  private readonly missing = new Set<ContentId>();
  /** Frozen `referrers()` answers; dropped whenever the reverse set changes. */
  private readonly referrerViews = new Map<ContentId, readonly ContentId[]>();

  // Mutation — the registry is the only caller.

  /** Re-linking is the override path: old edges are dropped first. */
  link(id: ContentId, refs: Iterable<ContentId>): void {
    if (this.forward.has(id) || this.defined.has(id)) this.unlink(id);

    this.defined.add(id);
    this.missing.delete(id);

    const out: ContentId[] = [];
    for (const r of refs) {
      // Self-reference dropped: it would make an asset its own referrer and hide
      // it from `orphans()`.
      if (r === id) continue;
      // Linear dedup: refs lists are a handful of ids, cheaper than a Set per asset.
      if (out.includes(r)) continue;
      out.push(r);
    }
    out.sort(compareIds);
    this.forward.set(id, Object.freeze(out));

    for (const r of out) {
      let back = this.reverse.get(r);
      if (!back) {
        back = new Set<ContentId>();
        this.reverse.set(r, back);
      }
      back.add(id);
      this.referrerViews.delete(r);
      if (!this.defined.has(r)) this.missing.add(r);
    }
  }

  // Inbound edges survive, so an unloaded-but-referenced id shows up in `dangling()`.
  unlink(id: ContentId): boolean {
    const had = this.defined.delete(id);

    const out = this.forward.get(id);
    if (out) {
      for (const r of out) {
        const back = this.reverse.get(r);
        if (!back) continue;
        back.delete(id);
        this.referrerViews.delete(r);
        if (back.size === 0) {
          this.reverse.delete(r);
          this.missing.delete(r);
        }
      }
      this.forward.delete(id);
    }

    const inbound = this.reverse.get(id);
    if (inbound && inbound.size > 0) this.missing.add(id);
    else this.missing.delete(id);

    return had;
  }

  clear(): void {
    this.forward.clear();
    this.reverse.clear();
    this.defined.clear();
    this.missing.clear();
    this.referrerViews.clear();
  }

  refs(id: ContentId): readonly ContentId[] {
    return this.forward.get(id) ?? NO_IDS;
  }

  /** Sorted, not insertion order — insertion order is load order. */
  referrers(id: ContentId): readonly ContentId[] {
    const cached = this.referrerViews.get(id);
    if (cached) return cached;
    const back = this.reverse.get(id);
    if (!back || back.size === 0) return NO_IDS;
    const view = Object.freeze([...back].sort(compareIds));
    this.referrerViews.set(id, view);
    return view;
  }

  has(id: ContentId): boolean {
    return this.defined.has(id);
  }

  get size(): number {
    return this.defined.size;
  }

  // Cycle-safe and iterative (a quest chain can be deep). The root appears only
  // when a cycle points back at it — that is a fact worth surfacing.
  reachable(root: ContentId): readonly ContentId[] {
    const seen = new Set<ContentId>([root]);
    const out = new Set<ContentId>();
    const stack: ContentId[] = [root];
    for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
      for (const r of this.refs(id)) {
        out.add(r);
        if (!seen.has(r)) {
          seen.add(r);
          stack.push(r);
        }
      }
    }
    return Object.freeze([...out].sort(compareIds));
  }

  dangling(): readonly ContentId[] {
    return Object.freeze([...this.missing].sort(compareIds));
  }

  // Loaded but unreachable. `enumeratedTypes` excludes the types the engine finds
  // wholesale, or every root reports as an orphan and the list is noise.
  orphans(enumeratedTypes: ReadonlySet<ContentTypeName>): readonly ContentId[] {
    const out: ContentId[] = [];
    for (const id of this.defined) {
      const back = this.reverse.get(id);
      if (back && back.size > 0) continue;
      const type = typeOf(id);
      if (type !== null && enumeratedTypes.has(type)) continue;
      out.push(id);
    }
    return Object.freeze(out.sort(compareIds));
  }
}
