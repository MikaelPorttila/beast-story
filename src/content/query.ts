// Condition eval and text resolution are INJECTED so this layer imports neither
// the state store nor i18n. `available()` is the only frame path; the rest is tooling.

import { compareIds } from "./ids";
import type { ContentGraph } from "./graph";
import type { ContentRegistry } from "./registry";
import type {
  Condition,
  ContentAsset,
  ContentId,
  ContentQuery,
  ContentText,
  ContentTypeName,
} from "./types";

const NO_ASSETS: readonly ContentAsset[] = Object.freeze([]);

/** Absent `when` means "always". */
export type ConditionEvaluator = (when: Condition | undefined) => boolean;

/** '' when absent. */
export type TextResolver = (text: ContentText | undefined) => string;

// Found by enumeration, never referenced — so excluded from `orphans()` by default.
// Not frozen: freezing a Set does not stop `add`; `ReadonlySet` is the real guard.
export const ENUMERATED_TYPES: ReadonlySet<ContentTypeName> = new Set<ContentTypeName>([
  "town",
  "biome",
  "enemy",
  "quest",
]);

export class Query implements ContentQuery {
  constructor(
    private readonly registry: ContentRegistry,
    private readonly graph: ContentGraph,
    private readonly evaluate: ConditionEvaluator,
    private readonly text: TextResolver,
    private readonly enumeratedTypes: ReadonlySet<ContentTypeName> = ENUMERATED_TYPES,
  ) {}

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

  /** Assets carrying EVERY tag. Zero tags answers empty, not everything. */
  byTag(...tags: readonly string[]): readonly ContentAsset[] {
    if (tags.length === 0) {
      return NO_ASSETS;
    }
    const out: ContentAsset[] = [];
    for (const asset of this.registry.assets()) {
      let ok = true;
      for (const tag of tags) {
        if (!asset.tags.includes(tag)) {
          ok = false;
          break;
        }
      }
      if (ok) {
        out.push(asset);
      }
    }
    return Object.freeze(out);
  }

  // Substring match over id, tags and resolved name. Sorted by id so tools can diff.
  search(text: string, type?: ContentTypeName): readonly ContentAsset[] {
    const needle = text.trim().toLowerCase();
    if (needle === "") {
      return NO_ASSETS;
    }
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
        hit = name !== "" && name.toLowerCase().includes(needle);
      }
      if (hit) {
        out.push(asset);
      }
    }
    out.sort((a, b) => compareIds(a.id, b.id));
    return Object.freeze(out);
  }

  // Returns the registry's own array until the first rejection, then backfills —
  // the all-pass case must allocate nothing.
  available<T = unknown>(type: ContentTypeName): readonly ContentAsset<T>[] {
    const all = this.registry.all<T>(type);
    let out: ContentAsset<T>[] | null = null;
    for (let i = 0; i < all.length; i++) {
      const asset = all[i];
      if (asset.when === undefined || this.evaluate(asset.when)) {
        if (out) {
          out.push(asset);
        }
      } else if (!out) {
        out = all.slice(0, i);
      }
    }
    return out ? Object.freeze(out) : all;
  }
}
