// Content compiled into the build.
// The CORE package is a STATIC import, never fetched: the starting world must run
// with no network at all, and a missing core.json must fail the BUILD.
// Everything else goes through `import.meta.glob` without `eager`, so each package
// is its own lazy chunk. A glob rather than a `public/` URL because `base: './'`
// means a hand-built URL is wrong on exactly the deployments nobody tests.
// A package id is the file's BASENAME, flat — a directory would put a `/` in an id
// that lands in saves and URLs — so two files cannot share one (first sorted wins,
// loser lands in `conflicts`) and every json under `data/` appears in `list()`.

import type { PackageId, StorageProvider } from '../types';
import { isPackageId } from '../ids';

// Static, so the bundler inlines it into the main chunk. Needs `resolveJsonModule`.
import coreJson from '../data/core.json';

const CORE: unknown = coreJson;

// The negative pattern is load-bearing: without it core.json also gains a dynamic
// import, which could split it back out of the main bundle.
const LAZY: Readonly<Record<string, () => Promise<unknown>>> = import.meta.glob(
  ['../data/**/*.json', '!../data/core.json'],
  { import: 'default' },
);

const CORE_KEY = '../data/core.json';

// A manifest's sibling file. No dots but the extension, so traversal is impossible
// by construction rather than by a `..` check.
const FILE_RE = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*\.json$/;

/** `../data/zones/dungeon.json` -> `dungeon`, or null when it is not a legal id. */
function packageIdOf(key: string): PackageId | null {
  const base = key.slice(key.lastIndexOf('/') + 1, -'.json'.length);
  return isPackageId(base) ? base : null;
}

function dirOf(key: string): string {
  const cut = key.lastIndexOf('/');
  return cut < 0 ? '' : key.slice(0, cut);
}

interface Index {
  readonly paths: ReadonlyMap<PackageId, string>;
  /** Basenames more than one file claimed, first-wins. */
  readonly conflicts: readonly string[];
}

// Keys only, so nothing is read. Sorted, so a collision's winner is a property of
// the tree rather than of the bundler's enumeration order.
function buildIndex(): Index {
  const paths = new Map<PackageId, string>();
  const conflicts: string[] = [];
  const keys = [CORE_KEY, ...Object.keys(LAZY)].sort();
  for (const key of keys) {
    const id = packageIdOf(key);
    if (id === null) continue;
    const held = paths.get(id);
    if (held !== undefined) {
      conflicts.push(`${key} is shadowed by ${held} (both are package "${id}")`);
      continue;
    }
    paths.set(id, key);
  }
  return { paths, conflicts };
}

const INDEX = buildIndex();

export interface BundledProviderOptions {
  /** Default sits above a remote provider and below a local development one. */
  readonly priority?: number;
  readonly name?: string;
}

/** Never writable: the answers come out of the JS bundle. */
export class BundledProvider implements StorageProvider {
  readonly name: string;
  readonly priority: number;
  readonly writable = false;

  constructor(opts: BundledProviderOptions = {}) {
    this.name = opts.name ?? 'bundled';
    this.priority = opts.priority ?? 50;
  }

  /** A field, not a throw: the package that WON still loads. */
  get conflicts(): readonly string[] {
    return INDEX.conflicts;
  }

  async list(): Promise<readonly PackageId[]> {
    return [...INDEX.paths.keys()].sort();
  }

  async read(pkg: PackageId, file?: string): Promise<unknown | null> {
    if (!isPackageId(pkg)) return null;
    const own = INDEX.paths.get(pkg);
    if (own === undefined) return null;

    let key = own;
    if (file !== undefined) {
      // Relative to the PACKAGE's own directory, and cannot escape it.
      if (!FILE_RE.test(file)) return null;
      const dir = dirOf(own);
      key = dir === '' ? file : `${dir}/${file}`;
    }

    if (key === CORE_KEY) return CORE === undefined ? null : CORE;
    const load = LAZY[key];
    if (load === undefined) return null;
    // A rejected chunk is an ABSENT package, not an exception, so the chain can
    // fall through to the next provider.
    try {
      const value = await load();
      return value === undefined ? null : value;
    } catch {
      return null;
    }
  }
}
