/**
 * The registry: every loaded `ContentAsset`, indexed by id and by type, plus the
 * reference graph kept in step with it (spec §6, §12.3).
 *
 * THE FIRST WRITER WINS, AND THAT IS THE ONE RULE THIS FILE IS BUILT AROUND.
 * A duplicate id is refused, reported as a diagnostic, and the asset already
 * present is kept. Last-writer-wins is the obvious alternative and it is wrong
 * here for a reason that only shows up in the field: load order is not
 * authorship order. A package is fetched when a zone edge is crossed or a quest
 * is offered, so which of two copies of `npc:gain` is "last" depends on the
 * route the player walked to get there — and a bug that reproduces on one route
 * and not another is a bug nobody can file. Refusing makes the collision a
 * finding at load time, in the same run, every time.
 *
 * AN OVERRIDE IS THEREFORE A DIFFERENT CALL, not a flag on `add`. A provider
 * that means to replace shipped content (spec §13.2's priority chain, a mod, an
 * editor's working copy) says so with `override()`, and the registry records the
 * package it shadowed. The distinction is the whole value: "two packages
 * accidentally used the same id" and "this package deliberately replaces that
 * one" are different events with different fixes, and a single `add` that
 * overwrote could not tell them apart.
 *
 * `all(type)` IS A FRAME PATH. Systems enumerate every enemy type, every town,
 * every biome per frame or per chunk, so it returns a CACHED FROZEN array rather
 * than building one per call — the cache is dropped when that type's list
 * changes, which happens per load and never during play. Frozen because the
 * cached array is the registry's own storage as far as the caller is concerned,
 * and a caller that sorted it in place would reorder the world.
 */

import { parseId } from './ids';
import { ContentGraph } from './graph';
import type {
  ContentAsset,
  ContentId,
  ContentLookup,
  ContentTypeName,
  Diagnostic,
  PackageId,
} from './types';

const NO_ASSETS: readonly ContentAsset[] = Object.freeze([]);
const NO_PACKAGES: readonly PackageId[] = Object.freeze([]);

export class ContentRegistry implements ContentLookup {
  /** Kept in step by `add`/`override`/`remove`; nothing else may link or unlink. */
  readonly graph: ContentGraph;

  private readonly assetsById = new Map<ContentId, ContentAsset>();
  /** Mutable per-type storage, in load order. `typeViews` is what callers see. */
  private readonly listsByType = new Map<ContentTypeName, ContentAsset[]>();
  private readonly typeViews = new Map<ContentTypeName, readonly ContentAsset[]>();
  private allView: readonly ContentAsset[] | null = null;
  private typeNamesView: readonly ContentTypeName[] | null = null;
  /**
   * Per id, the packages an `override()` shadowed, oldest first.
   *
   * The package ID rather than the shadowed ASSET: holding the record would keep
   * a whole package's parsed bodies alive after it unloaded, and restoring one on
   * unload is the loader's business — it knows what it read, and it is the thing
   * with a reason to put it back. What the registry owes is the attribution, so
   * "why is Gain wearing the wrong hat" has an answer that names a package.
   */
  private readonly shadows = new Map<ContentId, PackageId[]>();

  constructor(graph: ContentGraph = new ContentGraph()) {
    this.graph = graph;
  }

  // -------------------------------------------------------------------------
  // ContentLookup — the read side, hot
  // -------------------------------------------------------------------------

  get<T = unknown>(id: ContentId): ContentAsset<T> | undefined {
    return this.assetsById.get(id) as ContentAsset<T> | undefined;
  }

  has(id: ContentId): boolean {
    return this.assetsById.has(id);
  }

  /** Every loaded asset of a type, in load order. Cached and frozen — see header. */
  all<T = unknown>(type: ContentTypeName): readonly ContentAsset<T>[] {
    const cached = this.typeViews.get(type);
    if (cached) return cached as readonly ContentAsset<T>[];
    const list = this.listsByType.get(type);
    if (!list || list.length === 0) return NO_ASSETS as readonly ContentAsset<T>[];
    const view = Object.freeze(list.slice());
    this.typeViews.set(type, view);
    return view as readonly ContentAsset<T>[];
  }

  /**
   * Every loaded asset, in load order. Cached and frozen for the same reason
   * `all()` is — the query layer scans this for `byTag` and `search`.
   */
  assets(): readonly ContentAsset[] {
    if (this.allView) return this.allView;
    const view = Object.freeze([...this.assetsById.values()]);
    this.allView = view;
    return view;
  }

  /** Type names with at least one loaded asset, sorted. */
  types(): readonly ContentTypeName[] {
    if (this.typeNamesView) return this.typeNamesView;
    const view = Object.freeze([...this.listsByType.keys()].sort());
    this.typeNamesView = view;
    return view;
  }

  get size(): number {
    return this.assetsById.size;
  }

  /** Packages an `override()` shadowed at this id, oldest first. */
  shadowed(id: ContentId): readonly PackageId[] {
    return this.shadows.get(id) ?? NO_PACKAGES;
  }

  // -------------------------------------------------------------------------
  // Mutation — the loader's side
  // -------------------------------------------------------------------------

  /**
   * Install a new asset. Returns null on success, or the one diagnostic that
   * explains why it was refused — the caller collects it, and the rest of the
   * package still loads (types.ts, "a parser REPORTS rather than throws").
   */
  add(asset: ContentAsset): Diagnostic | null {
    const bad = this.checkIdentity(asset);
    if (bad) return bad;

    const existing = this.assetsById.get(asset.id);
    if (existing) {
      return {
        severity: 'error',
        code: 'duplicate-id',
        message:
          `duplicate content id "${asset.id}": already defined by package ` +
          `"${existing.pkg}" (${existing.source}); the copy from "${asset.pkg}" was ignored`,
        assetId: asset.id,
        assetType: asset.type,
        pkg: asset.pkg,
        source: asset.source,
        fix:
          'Rename one of the two, or — if the second is meant to replace the ' +
          'first — deliver it as a provider override rather than as a definition.',
      };
    }

    this.install(asset);
    return null;
  }

  /**
   * Deliberately replace whatever holds this id.
   *
   * The replacement takes the SHADOWED ASSET'S POSITION in its type list rather
   * than being appended. `all(type)` is documented as load order and several
   * systems read it positionally-in-effect ("the first town is the start town"),
   * so an override that moved an asset to the end of the list would change the
   * world in a way its author never asked for.
   *
   * Overriding an id nothing defines still installs, and returns a warning: the
   * asset is wanted either way, but an override that hits nothing is almost
   * always a typo in the id, and it is a typo that would otherwise be invisible
   * until a player noticed the change had not happened.
   */
  override(asset: ContentAsset): Diagnostic | null {
    const bad = this.checkIdentity(asset);
    if (bad) return bad;

    const existing = this.assetsById.get(asset.id);
    if (!existing) {
      this.install(asset);
      return {
        severity: 'warn',
        code: 'override-missing',
        message:
          `override of "${asset.id}" from package "${asset.pkg}" found nothing ` +
          'to replace; it was installed as a new definition',
        assetId: asset.id,
        assetType: asset.type,
        pkg: asset.pkg,
        source: asset.source,
        fix: 'Check the id against the asset you meant to replace.',
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
      if (at >= 0) list[at] = asset;
      else list.push(asset);
    } else {
      this.listsByType.set(asset.type, [asset]);
      this.typeNamesView = null;
    }
    // `link` replaces the outgoing edges; the override may point somewhere else.
    this.graph.link(asset.id, asset.refs);
    this.invalidate(existing.type);
    if (asset.type !== existing.type) this.invalidate(asset.type);
    return null;
  }

  /** Drop an asset. Returns whether there was one. */
  remove(id: ContentId): boolean {
    const existing = this.assetsById.get(id);
    if (!existing) return false;

    this.assetsById.delete(id);
    this.shadows.delete(id);
    const list = this.listsByType.get(existing.type);
    if (list) {
      const at = list.indexOf(existing);
      if (at >= 0) list.splice(at, 1);
      if (list.length === 0) {
        // Drop the empty bucket, or `types()` would go on naming a type whose
        // whole package unloaded, and every caller iterating types would get an
        // empty list back from a name that reads as present.
        this.listsByType.delete(existing.type);
        this.typeNamesView = null;
      }
    }
    // Unlink LAST: the graph keeps the inbound edges and moves the id into
    // `dangling()`, which is how unloading a package that others reference stays
    // visible instead of silently deleting every pointer to it.
    this.graph.unlink(id);
    this.invalidate(existing.type);
    return true;
  }

  /** Drop several. Returns how many were actually present. */
  removeMany(ids: Iterable<ContentId>): number {
    let n = 0;
    for (const id of ids) if (this.remove(id)) n++;
    return n;
  }

  /** Back to empty — the graph with it, since it is ours to keep in step. */
  clear(): void {
    this.assetsById.clear();
    this.listsByType.clear();
    this.typeViews.clear();
    this.shadows.clear();
    this.allView = null;
    this.typeNamesView = null;
    this.graph.clear();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The two things that must be true of an asset's identity before it may be
   * indexed by it.
   *
   * This looks like the loader's job and is partly a repeat of it, on purpose:
   * the registry is the thing that PROMISES `get(id)` and `all(type)` agree, and
   * an asset whose `type` field does not match the type inside its own id breaks
   * that promise quietly — it is findable one way and invisible the other. The
   * check is two string comparisons on a per-load path, and the data is
   * untrusted JSON.
   */
  private checkIdentity(asset: ContentAsset): Diagnostic | null {
    const parsed = parseId(asset.id);
    if (!parsed) {
      return {
        severity: 'error',
        code: 'malformed-id',
        message: `malformed content id ${JSON.stringify(asset.id)}`,
        assetId: asset.id,
        pkg: asset.pkg,
        source: asset.source,
        fix: 'Ids are "<type>:<name>", lower-case [a-z0-9-], with "/" to group names.',
      };
    }
    if (parsed.type !== asset.type) {
      return {
        severity: 'error',
        code: 'id-type-mismatch',
        message:
          `asset "${asset.id}" declares type "${asset.type}" but its id names ` +
          `"${parsed.type}"`,
        assetId: asset.id,
        assetType: asset.type,
        pkg: asset.pkg,
        source: asset.source,
        fix: 'The type is derived from the id and is never authored twice.',
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
