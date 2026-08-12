// Several providers, one answer: HIGHEST PRIORITY WINS, first non-null answer wins.
// Shipped order is local file > bundled > remote, so an edit shows on reload and a
// remote pack can only ADD to shipped content, never replace it.
// Null falls through; who answered is recorded for `ContentAsset.source`.

import type { PackageId, StorageProvider } from '../types';

export interface ChainRead {
  readonly value: unknown;
  readonly provider: StorageProvider;
  /** Stem of `ContentAsset.source`; the loader appends `#<index>` for inline assets. */
  readonly source: string;
}

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

  // Priority DESCENDING. `sort` is stable, so equal priorities keep insertion order.
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

  /** A throwing provider is skipped: a broken source must not hide a working one. */
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

  // Sorted, not priority order, so a listing is comparable between runs.
  // Best-effort: a provider that cannot enumerate (HTTP) contributes nothing.
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

  writer(): StorageProvider | undefined {
    return this.items.find((p) => p.writable && typeof p.write === 'function');
  }

  /** Throws with no writable provider: a save that went nowhere must fail loudly. */
  async write(pkg: PackageId, file: string | undefined, value: unknown): Promise<void> {
    const target = this.writer();
    if (target === undefined || target.write === undefined) {
      throw new Error(`content: no writable provider for package "${pkg}"`);
    }
    await target.write(pkg, file, value);
  }
}
