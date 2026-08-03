/**
 * CONTENT THAT SHIPS INSIDE THE BUILD (spec §13.1).
 *
 * THE CORE PACKAGE IS IMPORTED, NOT FETCHED, and that is the whole reason this
 * file exists rather than a `HttpProvider` pointed at our own origin. The issue's
 * hard requirement is that "the initial world should always be able to run
 * without any extra data being loaded": a request can fail, arrive late, be
 * cached stale, or be blocked by a proxy, and every one of those turns a shipped
 * game into a blank world. A static import cannot do any of that — the bundler
 * puts `content/data/core.json` in the main chunk beside `main.ts`, so a build
 * that shipped is a build whose core content shipped, and `read('core')` answers
 * without touching the network at all.
 *
 * EVERY OTHER PACKAGE IS LAZY, through `import.meta.glob` WITHOUT `eager`. That
 * form compiles to a `() => import(path)` per match, which is what makes each
 * package its own content-hashed chunk fetched on demand — a zone's data arrives
 * at the zone edge and a quest line's at the quest, which is the point of the
 * whole design.
 *
 * WHY A GLOB AND NOT A HAND-BUILT URL. There is no `public/` folder in this
 * project and adding one is the wrong move (see the asset note in AGENTS.md):
 * `base: './'` means a build can be served from any subfolder, Vite does not
 * rewrite string literals in JS, so a `public/` asset has to have its URL worked
 * out at runtime against `document.baseURI` — and gets that wrong on exactly the
 * deployments nobody tests. Imported, the bundler emits the file content-hashed
 * into `assets/` and writes the relative URL itself: if the page can load its own
 * JavaScript it can load these, on every way of serving the build.
 *
 * THE PACKAGE-ID MAPPING IS MECHANICAL AND FLAT. A package id is the file's
 * BASENAME without `.json`, and a directory is not part of it:
 *
 *     ../data/core.json            -> core
 *     ../data/zones/dungeon.json   -> dungeon
 *     ../data/quests/starter.json  -> starter
 *
 * Flat because a `ContentId` never names its package and a package id ends up in
 * save games, log lines and remote URLs (see ids.ts on why the grammar is
 * narrow) — folding a directory in would put a `/` in it and make `zone-dungeon`
 * and `zones/dungeon` two spellings of one thing. Directories are therefore an
 * AUTHORING convenience only.
 *
 * TWO CONSEQUENCES, both deliberate and neither silent. Two files cannot share a
 * basename — the first in sorted order wins and the loser is named in
 * `conflicts`. And EVERY json file under `data/` is addressable as a package,
 * including one that only exists to be a package's `files` entry, so such a file
 * appears in `list()` too. That is honest rather than tidy: this provider cannot
 * tell a sub-file from a package without reading it, and inventing a naming
 * convention to guess would be a rule to get wrong later. `list()` is a menu, not
 * an instruction — a caller loads the packages it wants by id.
 */

import type { PackageId, StorageProvider } from '../types';
import { isPackageId } from '../ids';

/**
 * The core package. A PLAIN STATIC IMPORT, and every word of that is deliberate.
 *
 * This is the line that makes the issue's requirement true at BUILD time rather
 * than at run time. A JSON module import is resolved by the bundler, so a
 * `core.json` that is missing, misnamed or moved is a build that does not
 * complete — not a game that starts and finds itself with no world. Measured on
 * the built output: the file's contents appear inline at the top of the main
 * chunk, there is no second chunk for it and no `import()` anywhere that names
 * it, so `read('core')` answers out of memory on the first frame.
 *
 * It requires `resolveJsonModule` in tsconfig.json, which is why that option is
 * on and carries a comment pointing back here.
 */
import coreJson from '../data/core.json';

/** Held as `unknown`: the loader narrows it exactly as it narrows a fetched body. */
const CORE: unknown = coreJson;

/**
 * Every other bundled package, lazily.
 *
 * The negative pattern is load-bearing, and the built output is how I know it:
 * without it `core.json` matches this glob too and gains a `() => import(...)`
 * of its own — a second, dynamic path to the one package that must never be a
 * request, and a chunk boundary that could split it back out of the main bundle.
 * With it, the only dynamic import in the output is the one for the genuinely
 * lazy package.
 */
const LAZY: Readonly<Record<string, () => Promise<unknown>>> = import.meta.glob(
  ['../data/**/*.json', '!../data/core.json'],
  { import: 'default' },
);

const CORE_KEY = '../data/core.json';

/**
 * A sibling file named by a package manifest's `files`.
 *
 * The grammar is as narrow as an id's and for the same reason: a name that would
 * need escaping in a URL or on a filesystem is not worth the freedom. It also
 * makes path traversal impossible by CONSTRUCTION rather than by a `..` check
 * somebody has to remember to write — no dots are admitted at all except the
 * extension, so there is no `..`, no `%2e%2e` after decoding and no absolute
 * path to normalise away.
 */
const FILE_RE = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*\.json$/;

/** `../data/zones/dungeon.json` -> `dungeon`, or null when it is not a legal id. */
function packageIdOf(key: string): PackageId | null {
  const base = key.slice(key.lastIndexOf('/') + 1, -'.json'.length);
  return isPackageId(base) ? base : null;
}

/** `../data/zones/dungeon.json` -> `../data/zones`. */
function dirOf(key: string): string {
  const cut = key.lastIndexOf('/');
  return cut < 0 ? '' : key.slice(0, cut);
}

interface Index {
  /** package id -> the glob key that serves it. */
  readonly paths: ReadonlyMap<PackageId, string>;
  /** Basenames that more than one file claimed, first-wins, for diagnostics. */
  readonly conflicts: readonly string[];
}

/**
 * Built once at module load from the glob KEYS alone — no file is read here, so
 * this costs a walk of a string record and nothing else. Sorted first so that
 * which file wins a basename collision is a property of the tree rather than of
 * the bundler's enumeration order, i.e. the same on every machine.
 */
function buildIndex(): Index {
  const paths = new Map<PackageId, string>();
  const conflicts: string[] = [];
  // CORE_KEY is unconditional: the import above guarantees it is here, which is
  // the whole point of importing rather than fetching it.
  const keys = [CORE_KEY, ...Object.keys(LAZY)].sort();
  for (const key of keys) {
    const id = packageIdOf(key);
    if (id === null) continue; // Not a legal package id; simply not offered.
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
  /**
   * Higher wins in a `ProviderChain`. The default sits ABOVE a remote provider
   * and below a local development one (spec §13.2) — what ships beats what is
   * fetched, and what a developer has open beats both.
   */
  readonly priority?: number;
  readonly name?: string;
}

/**
 * Serves the packages compiled into this build.
 *
 * Never writable: the answers come out of the JS bundle, and a bundle is not a
 * thing a running game can edit. An editor writes through a provider that has
 * somewhere to put the bytes (spec §13.1 requires saving elsewhere to fail
 * loudly rather than pretend).
 */
export class BundledProvider implements StorageProvider {
  readonly name: string;
  readonly priority: number;
  readonly writable = false;

  constructor(opts: BundledProviderOptions = {}) {
    this.name = opts.name ?? 'bundled';
    this.priority = opts.priority ?? 50;
  }

  /**
   * Basenames that lost a collision. Empty in a healthy tree; a non-empty one is
   * a build-time authoring mistake worth surfacing rather than a runtime error,
   * which is why it is a field and not a thrown exception — the package that WON
   * still loads, and the game still runs.
   */
  get conflicts(): readonly string[] {
    return INDEX.conflicts;
  }

  /** Every package this build carries. Cheap: the index is keys, already built. */
  async list(): Promise<readonly PackageId[]> {
    return [...INDEX.paths.keys()].sort();
  }

  async read(pkg: PackageId, file?: string): Promise<unknown | null> {
    if (!isPackageId(pkg)) return null;
    const own = INDEX.paths.get(pkg);
    if (own === undefined) return null;

    let key = own;
    if (file !== undefined) {
      // Resolved RELATIVE TO THE PACKAGE, per the `StorageProvider.read`
      // contract: a manifest names its siblings, so `files: ["enemies.json"]`
      // in `../data/zones/dungeon.json` means `../data/zones/enemies.json` and
      // cannot mean anything outside that directory.
      if (!FILE_RE.test(file)) return null;
      const dir = dirOf(own);
      key = dir === '' ? file : `${dir}/${file}`;
    }

    if (key === CORE_KEY) return CORE === undefined ? null : CORE;
    const load = LAZY[key];
    if (load === undefined) return null;
    // The one await in this file. A rejected chunk (offline mid-session, a
    // pruned deploy) is an ABSENT package, not an exception: the chain falls
    // through to the next provider and the loader turns a final null into a
    // diagnostic. Throwing here would make every caller wrap every read.
    try {
      const value = await load();
      return value === undefined ? null : value;
    } catch {
      return null;
    }
  }
}
