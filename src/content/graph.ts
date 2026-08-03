/**
 * The reference graph — forward edges from `ContentAsset.refs`, and the reverse
 * index that is the whole reason this file exists (spec §4.3, §14.2).
 *
 * FORWARD EDGES ARE NEVER RE-DERIVED HERE. The type's own `refs()` already
 * walked the parsed body once, at parse time, and the result is on the asset;
 * re-walking a body in the graph would be a second extractor that agrees with
 * the first until the day someone adds a field to one of them. So `link()` takes
 * the ids and asks no questions about where they came from.
 *
 * REVERSE EDGES ARE RECORDED EVEN WHEN THE TARGET DOES NOT EXIST, and that is
 * the property the rest of the design leans on. Load order is not authorship
 * order: a quest pack may name `npc:gain` a full zone load before the package
 * defining him arrives, and a graph that only recorded edges between two loaded
 * assets would answer `referrers('npc:gain')` differently depending on which
 * file the loader happened to read first. Recording the edge on sight makes the
 * answer independent of order, and it is also what lets `dangling()` exist at
 * all — a reference to nothing is only visible if it was written down.
 *
 * WHAT IS "DEFINED" is tracked here as well as in the registry, which looks like
 * two sources of truth and is not: nothing outside `link`/`unlink` may touch it,
 * and the registry calls those on every add and every remove, so the set cannot
 * drift from the registry's map. The alternative — asking the registry — would
 * make the graph depend on the registry, and the registry already depends on the
 * graph.
 *
 * Nothing in here reaches for the world, the DOM or three.js; it is ids and Sets
 * (content/types.ts, "three things this deliberately does not do").
 */

import { compareIds, typeOf } from './ids';
import type { ContentId, ContentTypeName } from './types';

/** Shared empty answer, so a miss on a hot read allocates nothing. */
const NO_IDS: readonly ContentId[] = Object.freeze([]);

export class ContentGraph {
  /** id -> the ids it points at. Frozen, deduped, sorted; the answer `refs()` hands out. */
  private readonly forward = new Map<ContentId, readonly ContentId[]>();
  /** id -> the ids pointing at it. Present for undefined targets too — see the header. */
  private readonly reverse = new Map<ContentId, Set<ContentId>>();
  /** Ids with a defining asset loaded right now. */
  private readonly defined = new Set<ContentId>();
  /**
   * Referenced by something, defined by nothing. Maintained incrementally rather
   * than computed on demand, because `dangling()` is what a build check runs and
   * a scan of every reverse key would make it O(edges) on a path that is asked
   * after every load.
   */
  private readonly missing = new Set<ContentId>();
  /**
   * Cached frozen answers for `referrers()`. An entry is dropped the moment its
   * reverse set changes, so a stale one cannot be served; the cache exists
   * because `referrers` is read per frame by anything asking "who points at the
   * town I am standing in", and building an array per call is exactly the
   * per-frame allocation the house rules forbid.
   */
  private readonly referrerViews = new Map<ContentId, readonly ContentId[]>();

  // -------------------------------------------------------------------------
  // Mutation — the registry is the only caller
  // -------------------------------------------------------------------------

  /**
   * Record `id` as defined and replace its outgoing edges.
   *
   * Re-linking an id that is already present is the override path and is
   * deliberately supported: it drops the old edges first, so an override that
   * points somewhere new does not leave the old target believing it is still
   * referenced.
   */
  link(id: ContentId, refs: Iterable<ContentId>): void {
    if (this.forward.has(id) || this.defined.has(id)) this.unlink(id);

    this.defined.add(id);
    this.missing.delete(id);

    const out: ContentId[] = [];
    for (const r of refs) {
      // A SELF-REFERENCE IS DROPPED. Keeping it would make an asset its own
      // referrer, which hides it from `orphans()` — and an asset nothing else
      // points at is precisely what `orphans()` is for. It would also put the
      // root into its own `reachable()` set for a reason that is not a cycle.
      if (r === id) continue;
      // Linear dedup rather than a Set: a refs list is a handful of ids (a
      // town's NPCs, a quest's prerequisites), and allocating a Set per asset
      // to deduplicate four strings costs more than the scan.
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

  /**
   * Forget `id`'s definition and its outgoing edges. Returns whether it had one.
   *
   * The edges pointing AT it survive, and it joins `dangling()` if any do. That
   * is the point: unloading a package that half the world references is a thing
   * the runtime must be able to SEE, not a thing that silently makes every
   * pointer to it evaporate.
   */
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

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Ids `id` points at, deduped and sorted. Frozen; allocation-free on repeat. */
  refs(id: ContentId): readonly ContentId[] {
    return this.forward.get(id) ?? NO_IDS;
  }

  /**
   * Ids pointing AT `id`, sorted. Correct for an id nothing has defined yet.
   *
   * Sorted rather than in insertion order because insertion order is load order,
   * and load order changes the moment a package is split — the same reasoning as
   * `compareIds` in ids.ts.
   */
  referrers(id: ContentId): readonly ContentId[] {
    const cached = this.referrerViews.get(id);
    if (cached) return cached;
    const back = this.reverse.get(id);
    if (!back || back.size === 0) return NO_IDS;
    const view = Object.freeze([...back].sort(compareIds));
    this.referrerViews.set(id, view);
    return view;
  }

  /** True when an asset defining `id` is loaded. */
  has(id: ContentId): boolean {
    return this.defined.has(id);
  }

  /** How many ids have a defining asset. */
  get size(): number {
    return this.defined.size;
  }

  /**
   * Every id reachable from `root` by following references, cycle-safe.
   *
   * The root itself is EXCLUDED unless something it reaches points back at it —
   * "reachable from" is a question about consequences ("what does loading this
   * drag in"), and answering it with the thing you already have adds nothing.
   * When the root does come back it is because there is a cycle, which is a fact
   * worth surfacing rather than filtering out.
   *
   * Iterative rather than recursive: a quest line is a chain, and a deep enough
   * one would blow the stack on a path a validator runs over every asset.
   */
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

  /** Ids something references that nothing defines. Sorted. */
  dangling(): readonly ContentId[] {
    return Object.freeze([...this.missing].sort(compareIds));
  }

  /**
   * Loaded assets nothing points at — content that is present and unreachable.
   *
   * `enumeratedTypes` NAMES THE TYPES THE ENGINE FINDS WHOLESALE, and passing it
   * is what makes this diagnostic worth reading. A town is not referenced by
   * anything; the world asks `all('town')` and places every one it gets. Same for
   * a biome, an enemy species, a quest offered from the journal. Without the
   * exclusion every root in the game reports as an orphan, the list is longer
   * than the list of real findings, and a warning nobody reads is a warning that
   * is off. What is LEFT after the exclusion is the actual defect: an NPC no town
   * places, a dialogue no NPC opens, a reward table no quest grants — content
   * that shipped and that no code path can ever reach.
   */
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
