/**
 * The graph and availability questions tools, agents and gameplay ask
 * (spec §18.2, §19) — the implementation of `ContentQuery`.
 *
 * EVERYTHING IT NEEDS BEYOND THE REGISTRY AND THE GRAPH IS INJECTED, and that is
 * a structural decision rather than a testing convenience. Condition evaluation
 * lives with the state store and text resolution lives with i18n; importing
 * either here would make the query layer depend on both, and then a headless
 * tool that only wants to ask "what points at this town" would drag the string
 * tables and the save format in with it. Two callbacks instead, so this file
 * imports nothing but `./types`, `./ids`, `./registry` and `./graph`.
 *
 * NOTHING IN HERE BUILDS AN INDEX, and `search` is the case worth saying it
 * about: it is a linear scan over every loaded asset. That is a TOOLING path —
 * an editor's filter box, a `__dbgContent` lookup, an agent asking what exists —
 * driven by a human typing, at a scale of hundreds to low thousands of assets. A
 * trigram or prefix index would be code to maintain on every add, remove and
 * override, invalidated on every language change (the display name is part of
 * the match), to save microseconds nobody is waiting on. `available()` is the
 * one method here that a frame may call, and it is the one that avoids
 * allocating.
 */

import { compareIds } from './ids';
import type { ContentGraph } from './graph';
import type { ContentRegistry } from './registry';
import type {
  Condition,
  ContentAsset,
  ContentId,
  ContentQuery,
  ContentText,
  ContentTypeName,
} from './types';

const NO_ASSETS: readonly ContentAsset[] = Object.freeze([]);

/** Injected: the live condition evaluator. Absent `when` means "always". */
export type ConditionEvaluator = (when: Condition | undefined) => boolean;

/** Injected: resolve a `ContentText` for the current language. '' when absent. */
export type TextResolver = (text: ContentText | undefined) => string;

/**
 * The types the engine finds by ENUMERATION rather than by reference, and so the
 * default exclusion for `orphans()`.
 *
 * A town is placed because the world asked `all('town')`; a biome is chosen the
 * same way, an enemy species is drawn from the whole roster, and a quest is
 * offered from the journal. None of them is pointed at by anything, so all of
 * them would report as orphaned content and bury the findings that are real.
 * A runtime with its own set of roots passes it; this is the default so a caller
 * that has not thought about it gets the useful answer rather than the noisy one.
 */
// Not `Object.freeze`d: freezing a Set stops property writes and does nothing
// about `add`, so it would claim a guarantee it does not deliver. `ReadonlySet`
// is the real protection and it is the compiler's.
export const ENUMERATED_TYPES: ReadonlySet<ContentTypeName> = new Set<ContentTypeName>([
  'town',
  'biome',
  'enemy',
  'quest',
]);

export class Query implements ContentQuery {
  constructor(
    private readonly registry: ContentRegistry,
    private readonly graph: ContentGraph,
    private readonly evaluate: ConditionEvaluator,
    private readonly text: TextResolver,
    private readonly enumeratedTypes: ReadonlySet<ContentTypeName> = ENUMERATED_TYPES,
  ) {}

  // -------------------------------------------------------------------------
  // Graph questions — the graph owns the indexes, this is the public shape
  // -------------------------------------------------------------------------

  refs(id: ContentId): readonly ContentId[] {
    return this.graph.refs(id);
  }

  referrers(id: ContentId): readonly ContentId[] {
    return this.graph.referrers(id);
  }

  reachable(root: ContentId): readonly ContentId[] {
    return this.graph.reachable(root);
  }

  dangling(): readonly ContentId[] {
    return this.graph.dangling();
  }

  orphans(): readonly ContentId[] {
    return this.graph.orphans(this.enumeratedTypes);
  }

  // -------------------------------------------------------------------------
  // Content questions
  // -------------------------------------------------------------------------

  /**
   * Assets carrying EVERY one of these tags.
   *
   * A zero-tag call answers with nothing rather than with everything. The
   * vacuous reading ("no constraint, so all of it") is the tidier one on paper
   * and the wrong one at the call site: this is spread from a list of selected
   * filters, and a selection nobody made returning the entire registry is a UI
   * that looks like it filtered and did not. Empty is a visibly empty answer.
   */
  byTag(...tags: readonly string[]): readonly ContentAsset[] {
    if (tags.length === 0) return NO_ASSETS;
    const out: ContentAsset[] = [];
    for (const asset of this.registry.assets()) {
      let ok = true;
      for (const tag of tags) {
        if (!asset.tags.includes(tag)) {
          ok = false;
          break;
        }
      }
      if (ok) out.push(asset);
    }
    return Object.freeze(out);
  }

  /**
   * Case-insensitive substring match over id, tags and resolved display name,
   * optionally narrowed to one type. Sorted by id, because a result list that
   * reorders between two runs is one a tool cannot diff.
   *
   * The display name goes through the injected resolver, so a search matches
   * what the player is actually shown in the language they are shown it in —
   * "Redbriar" finds `town:encampment` and so does "encampment".
   */
  search(text: string, type?: ContentTypeName): readonly ContentAsset[] {
    const needle = text.trim().toLowerCase();
    if (needle === '') return NO_ASSETS;
    const pool = type === undefined ? this.registry.assets() : this.registry.all(type);
    const out: ContentAsset[] = [];
    for (const asset of pool) {
      if (asset.id.toLowerCase().includes(needle)) {
        out.push(asset);
        continue;
      }
      let hit = false;
      for (const tag of asset.tags) {
        if (tag.toLowerCase().includes(needle)) {
          hit = true;
          break;
        }
      }
      if (!hit) {
        const name = this.text(asset.name);
        hit = name !== '' && name.toLowerCase().includes(needle);
      }
      if (hit) out.push(asset);
    }
    out.sort((a, b) => compareIds(a.id, b.id));
    return Object.freeze(out);
  }

  /**
   * Loaded assets of a type whose `when` passes against current state.
   *
   * THE COMMON ANSWER IS THE WHOLE LIST, AND IT COSTS NOTHING. Most content
   * carries no `when` at all, so the filtered result is the registry's own
   * cached array — this returns that array itself and allocates only from the
   * first rejection onward, backfilling the assets already accepted. That is the
   * no-per-frame-allocation rule applied to the one method here a frame may
   * plausibly call (a talk prompt asking which quests an NPC can offer).
   *
   * `when === undefined` short-circuits ahead of the evaluator rather than
   * relying on it to answer true for absent, because "absent means always" is
   * this file's business as much as the evaluator's, and skipping the call is
   * what makes the ungated case free.
   */
  available<T = unknown>(type: ContentTypeName): readonly ContentAsset<T>[] {
    const all = this.registry.all<T>(type);
    let out: ContentAsset<T>[] | null = null;
    for (let i = 0; i < all.length; i++) {
      const asset = all[i];
      if (asset.when === undefined || this.evaluate(asset.when)) {
        if (out) out.push(asset);
      } else if (!out) {
        out = all.slice(0, i);
      }
    }
    return out ? Object.freeze(out) : all;
  }
}
