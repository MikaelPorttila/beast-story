// FIRST WRITER WINS: a duplicate id is refused and reported, because load order
// is not authorship order (a route-dependent winner is an unfilable bug).
// A deliberate replacement is `override()`, never a flag on `add`.
// `all(type)` is a frame path: cached frozen arrays, invalidated per load.

import { parseId } from "./ids";
import { ContentGraph } from "./graph";
import type {
  ContentAsset,
  ContentId,
  ContentLookup,
  ContentTypeName,
  Diagnostic,
  PackageId,
} from "./types";

const NO_ASSETS: readonly ContentAsset[] = Object.freeze([]);
const NO_PACKAGES: readonly PackageId[] = Object.freeze([]);

export class ContentRegistry implements ContentLookup {
  /** Nothing but `add`/`override`/`remove` may link or unlink. */
  readonly graph: ContentGraph;

  private readonly assetsById = new Map<ContentId, ContentAsset>();
  /** Mutable, load order. `typeViews` is what callers see. */
  private readonly listsByType = new Map<ContentTypeName, ContentAsset[]>();
  private readonly typeViews = new Map<ContentTypeName, readonly ContentAsset[]>();
  private allView: readonly ContentAsset[] | null = null;
  private typeNamesView: readonly ContentTypeName[] | null = null;
  // Package ids, not the shadowed assets — holding those would keep an unloaded
  // package's bodies alive. Restoring one is the loader's business.
  private readonly shadows = new Map<ContentId, PackageId[]>();

  constructor(graph: ContentGraph = new ContentGraph()) {
    this.graph = graph;
  }

  get<T = unknown>(id: ContentId): ContentAsset<T> | undefined {
    return this.assetsById.get(id) as ContentAsset<T> | undefined;
  }

  has(id: ContentId): boolean {
    return this.assetsById.has(id);
  }

  all<T = unknown>(type: ContentTypeName): readonly ContentAsset<T>[] {
    const cached = this.typeViews.get(type);
    if (cached) {
      return cached as readonly ContentAsset<T>[];
    }
    const list = this.listsByType.get(type);
    if (!list || list.length === 0) {
      return NO_ASSETS as readonly ContentAsset<T>[];
    }
    const view = Object.freeze(list.slice());
    this.typeViews.set(type, view);
    return view as readonly ContentAsset<T>[];
  }

  /** Load order, cached and frozen; the query layer scans it. */
  assets(): readonly ContentAsset[] {
    if (this.allView) {
      return this.allView;
    }
    const view = Object.freeze([...this.assetsById.values()]);
    this.allView = view;
    return view;
  }

  types(): readonly ContentTypeName[] {
    if (this.typeNamesView) {
      return this.typeNamesView;
    }
    const view = Object.freeze([...this.listsByType.keys()].toSorted());
    this.typeNamesView = view;
    return view;
  }

  get size(): number {
    return this.assetsById.size;
  }

  /** Oldest first. */
  shadowed(id: ContentId): readonly PackageId[] {
    return this.shadows.get(id) ?? NO_PACKAGES;
  }

  /** Null on success, else the refusal — the rest of the package still loads. */
  add(asset: ContentAsset): Diagnostic | null {
    const bad = this.checkIdentity(asset);
    if (bad) {
      return bad;
    }

    const existing = this.assetsById.get(asset.id);
    if (existing) {
      return {
        severity: "error",
        code: "duplicate-id",
        message:
          `duplicate content id "${asset.id}": already defined by package ` +
          `"${existing.pkg}" (${existing.source}); the copy from "${asset.pkg}" was ignored`,
        assetId: asset.id,
        assetType: asset.type,
        pkg: asset.pkg,
        source: asset.source,
        fix:
          "Rename one of the two, or — if the second is meant to replace the " +
          "first — deliver it as a provider override rather than as a definition.",
      };
    }

    this.install(asset);
    return null;
  }

  // Replaces in PLACE: callers read `all(type)` positionally, so appending would
  // silently reorder the world. Overriding nothing installs anyway, plus a warning.
  override(asset: ContentAsset): Diagnostic | null {
    const bad = this.checkIdentity(asset);
    if (bad) {
      return bad;
    }

    const existing = this.assetsById.get(asset.id);
    if (!existing) {
      this.install(asset);
      return {
        severity: "warn",
        code: "override-missing",
        message:
          `override of "${asset.id}" from package "${asset.pkg}" found nothing ` +
          "to replace; it was installed as a new definition",
        assetId: asset.id,
        assetType: asset.type,
        pkg: asset.pkg,
        source: asset.source,
        fix: "Check the id against the asset you meant to replace.",
      };
    }

    let chain = this.shadows.get(asset.id);
    if (!chain) {
      chain = [];
      this.shadows.set(asset.id, chain);
    }
    chain.push(existing.pkg);

    this.assetsById.set(asset.id, asset);
    const list = this.listsByType.get(existing.type);
    if (list) {
      const at = list.indexOf(existing);
      if (at >= 0) {
        list[at] = asset;
      } else {
        list.push(asset);
      }
    } else {
      this.listsByType.set(asset.type, [asset]);
      this.typeNamesView = null;
    }
    this.graph.link(asset.id, asset.refs);
    this.invalidate(existing.type);
    if (asset.type !== existing.type) {
      this.invalidate(asset.type);
    }
    return null;
  }

  remove(id: ContentId): boolean {
    const existing = this.assetsById.get(id);
    if (!existing) {
      return false;
    }

    this.assetsById.delete(id);
    this.shadows.delete(id);
    const list = this.listsByType.get(existing.type);
    if (list) {
      const at = list.indexOf(existing);
      if (at >= 0) {
        list.splice(at, 1);
      }
      if (list.length === 0) {
        // Drop the empty bucket, or `types()` keeps naming an unloaded type.
        this.listsByType.delete(existing.type);
        this.typeNamesView = null;
      }
    }
    // Unlink LAST: inbound edges survive, so the id shows up in `dangling()`.
    this.graph.unlink(id);
    this.invalidate(existing.type);
    return true;
  }

  /** Returns how many were present. */
  removeMany(ids: Iterable<ContentId>): number {
    let n = 0;
    for (const id of ids) {
      if (this.remove(id)) {
        n++;
      }
    }
    return n;
  }

  clear(): void {
    this.assetsById.clear();
    this.listsByType.clear();
    this.typeViews.clear();
    this.shadows.clear();
    this.allView = null;
    this.typeNamesView = null;
    this.graph.clear();
  }

  // Re-checked here even though the loader also does: `get(id)` and `all(type)`
  // must agree, and a type/id mismatch breaks that silently.
  private checkIdentity(asset: ContentAsset): Diagnostic | null {
    const parsed = parseId(asset.id);
    if (!parsed) {
      return {
        severity: "error",
        code: "malformed-id",
        message: `malformed content id ${JSON.stringify(asset.id)}`,
        assetId: asset.id,
        pkg: asset.pkg,
        source: asset.source,
        fix: 'Ids are "<type>:<name>", lower-case [a-z0-9-], with "/" to group names.',
      };
    }
    if (parsed.type !== asset.type) {
      return {
        severity: "error",
        code: "id-type-mismatch",
        message:
          `asset "${asset.id}" declares type "${asset.type}" but its id names ` +
          `"${parsed.type}"`,
        assetId: asset.id,
        assetType: asset.type,
        pkg: asset.pkg,
        source: asset.source,
        fix: "The type is derived from the id and is never authored twice.",
      };
    }
    return null;
  }

  private install(asset: ContentAsset): void {
    this.assetsById.set(asset.id, asset);
    let list = this.listsByType.get(asset.type);
    if (!list) {
      list = [];
      this.listsByType.set(asset.type, list);
      this.typeNamesView = null;
    }
    list.push(asset);
    this.graph.link(asset.id, asset.refs);
    this.invalidate(asset.type);
  }

  private invalidate(type: ContentTypeName): void {
    this.typeViews.delete(type);
    this.allView = null;
  }
}
