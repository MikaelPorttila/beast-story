/**
 * SOURCE PRIORITY (spec §13.2) — several providers, one answer.
 *
 * The runtime never knows whether an asset was bundled, fetched or read off
 * disk, which is what leaves room for a database or a content service later
 * without touching a caller. What it does need is a rule for what happens when
 * two of them offer the same package, and the rule is: HIGHEST PRIORITY WINS,
 * FIRST NON-NULL ANSWER IS THE ANSWER.
 *
 * The ordering that falls out of the shipped priorities is the one a developer
 * wants and a player never sees: a LOCAL DEVELOPMENT FILE overrides a BUNDLED
 * one, and a bundled one overrides a REMOTE one. Editing `core.json` and
 * reloading has to show the edit — a chain that preferred the compiled copy
 * would make the whole content pipeline untestable without a rebuild. And a
 * remote pack must never be able to REPLACE shipped content, only add to it:
 * that is the same statement as "the initial world always runs", one layer up.
 *
 * NULL IS THE FALL-THROUGH, not a failure. `StorageProvider.read` returns null
 * when a provider does not have a package, which is the normal case for most
 * providers on most packages — so a provider that throws is a bug in that
 * provider, and one that is merely absent costs nothing.
 *
 * WHO ANSWERED IS RECORDED, because `ContentAsset.source` has to name it. A
 * diagnostic reading `bundled:core#3` tells you which file to open; one reading
 * "asset 3" does not, and after the third provider is added nothing else can
 * reconstruct it.
 */

import type { PackageId, StorageProvider } from '../types';

/** One provider's answer, with the provenance the loader stamps onto assets. */
export interface ChainRead {
  readonly value: unknown;
  readonly provider: StorageProvider;
  /**
   * `<provider>:<pkg>` or `<provider>:<pkg>/<file>` — the stem of every
   * `ContentAsset.source`; the loader appends `#<index>` for an inline asset.
   */
  readonly source: string;
}

/** The stem, in one place, so a diagnostic and an asset never disagree. */
export function sourceOf(provider: StorageProvider, pkg: PackageId, file?: string): string {
  return file === undefined ? `${provider.name}:${pkg}` : `${provider.name}:${pkg}/${file}`;
}

export class ProviderChain {
  private readonly items: StorageProvider[] = [];

  constructor(providers: readonly StorageProvider[] = []) {
    for (const p of providers) this.add(p);
  }

  /** Highest priority first. */
  get providers(): readonly StorageProvider[] {
    return this.items;
  }

  /**
   * Insert, keeping the list sorted by priority DESCENDING.
   *
   * `Array.prototype.sort` is stable (ES2019+), so equal priorities keep
   * insertion order — which makes "add a provider" a deterministic operation
   * rather than one whose outcome depends on the engine's sort. Two providers at
   * the same priority is a legitimate arrangement (two remote hosts), and the
   * one added first should keep winning after a third is added elsewhere.
   */
  add(provider: StorageProvider): void {
    this.items.push(provider);
    this.items.sort((a, b) => b.priority - a.priority);
  }

  remove(provider: StorageProvider): boolean {
    const i = this.items.indexOf(provider);
    if (i < 0) return false;
    this.items.splice(i, 1);
    return true;
  }

  /**
   * The first provider that has it, with provenance.
   *
   * A provider that THROWS is skipped rather than allowed to take down the
   * chain: a broken source must not be able to hide a working one behind it,
   * which is the same argument as null-falls-through with a worse-behaved
   * neighbour.
   */
  async read(pkg: PackageId, file?: string): Promise<ChainRead | null> {
    for (const provider of this.items) {
      let value: unknown;
      try {
        value = await provider.read(pkg, file);
      } catch {
        continue;
      }
      if (value === null || value === undefined) continue;
      return { value, provider, source: sourceOf(provider, pkg, file) };
    }
    return null;
  }

  /**
   * The union of what every provider can enumerate, deduplicated and SORTED.
   *
   * Sorted because this is what a listing, a diagnostic or `__dbgContent()`
   * shows, and priority order would make the same set of packages print
   * differently the moment a provider is added — see the note on `compareIds` in
   * ids.ts for why a stable order is what makes two runs comparable.
   *
   * Enumeration is best-effort by construction: a provider that cannot list
   * (HTTP has no directory listing) contributes nothing, and a package it can
   * still `read` is simply not in this answer.
   */
  async list(): Promise<readonly PackageId[]> {
    const seen = new Set<PackageId>();
    const lists = await Promise.all(
      this.items.map(async (p) => {
        try {
          return await p.list();
        } catch {
          return [] as readonly PackageId[];
        }
      }),
    );
    for (const ids of lists) for (const id of ids) seen.add(id);
    return [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /** The highest-priority provider that can be written to, if any. */
  writer(): StorageProvider | undefined {
    return this.items.find((p) => p.writable && typeof p.write === 'function');
  }

  /**
   * Write through the highest-priority writable provider.
   *
   * Throws when there is none, and that is deliberate (spec §13.1: saving
   * elsewhere must fail LOUDLY). Every other failure in this file is an absence
   * a caller can carry on through; a save that silently went nowhere is data the
   * author believes they have and does not.
   */
  async write(pkg: PackageId, file: string | undefined, value: unknown): Promise<void> {
    const target = this.writer();
    if (target === undefined || target.write === undefined) {
      throw new Error(`content: no writable provider for package "${pkg}"`);
    }
    await target.write(pkg, file, value);
  }
}
