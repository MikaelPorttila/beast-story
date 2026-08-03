/**
 * TURNING A PACKAGE INTO LOADED CONTENT (spec §12, §14, §15).
 *
 * This is the only async part of the content runtime. Everything the frame loop
 * asks — `get`, `all`, `evaluate` — is synchronous against what this file has
 * already put in the registry, because a promise per NPC prompt is a frame
 * hitch. So a load happens at a boot phase or a zone edge and never anywhere
 * else, and nothing in here may be called per frame.
 *
 * WHAT A LOAD IS, in order, and every step of the order is load-bearing:
 *
 *   1. `requires` FIRST, depth-first. A package's assets may reference a
 *      dependency's, so the dependency has to be in the registry before the
 *      reference is extracted — otherwise every cross-package ref would look
 *      dangling at the moment it was made and the graph would be a function of
 *      load order rather than of the content.
 *   2. `optional` next. A missing one is a WARNING: that is the entire
 *      difference between the two lists, and it is what lets a build ship
 *      without a quest pack that a later build adds.
 *   3. The package's own inline `assets`, then each of its `files`. Inline
 *      first so a manifest reads top to bottom the way it was written.
 *
 * A CYCLE IS A DIAGNOSTIC, NOT A STACK OVERFLOW. Two packages that require each
 * other are an authoring mistake, and an authoring mistake must produce a
 * sentence naming both packages — not a `RangeError` with a thousand identical
 * frames, and not a hang. There are TWO ways a cycle can appear and both are
 * closed here: within one depth-first walk (the `chain` argument), and ACROSS
 * two concurrent `load()` calls that are each waiting on the other's in-flight
 * promise (`blockedOn`). The second is the one that would not throw at all — it
 * would simply never settle, which is the worst failure of the three.
 *
 * IDEMPOTENT, AND SHARED WHILE IN FLIGHT. Loading a package that is loaded adds
 * a lease and returns `loaded: false`. Two `load()` calls that overlap share one
 * promise rather than fetching twice — a zone edge and a quest trigger firing in
 * the same frame is not exotic, and two parses of one file would race to insert
 * the same ids and produce a `duplicate-id` for content that is merely popular.
 *
 * UNLOADING DROPS DEFINITIONS AND NEVER TOUCHES PLAYER STATE (spec §12.3). When
 * the last lease on a package goes its assets leave the registry — and the
 * flags, quest statuses, progress counters and discoveries that were set while
 * it was loaded stay exactly where they are. That asymmetry is the design: state
 * is keyed by ID (spec §9.3), so a quest that is completed stays completed while
 * its definition is unloaded, and reloading the package makes the same facts
 * mean the same thing again. A loader that "cleaned up" a player's progress with
 * the definitions would turn a zone change into save corruption.
 */

import type {
  ContentAsset,
  ContentId,
  ContentText,
  ContentTypeDef,
  ContentTypeName,
  Condition,
  Diagnostic,
  Lease,
  LoadResult,
  PackageId,
  PackageInfo,
  ParseCtx,
} from './types';
import { isId, isPackageId, typeOf } from './ids';
import type { ProviderChain } from './storage/chain';

// ---------------------------------------------------------------------------
// What the loader needs from its neighbours
// ---------------------------------------------------------------------------

/**
 * The slice of the registry this file uses.
 *
 * Declared here, narrowly, rather than imported from `registry.ts`, for the
 * reason `src/core/types.ts` exists at all: a module should depend on a contract
 * and not on an implementation. It also means this file compiles, and can be
 * tested, against a three-method stub.
 *
 * `has` rather than an `add` that reports: the loader owns the DIAGNOSTIC for a
 * duplicate id (it is the only one holding the package, source and index that
 * make the message actionable), so the sink stays a dumb store.
 */
export interface AssetSink {
  add(asset: ContentAsset): void;
  remove(id: ContentId): void;
  has(id: ContentId): boolean;
}

/** The type table, as the loader reads it. */
export interface TypeSource {
  type(name: ContentTypeName): ContentTypeDef | undefined;
}

export interface PackageLoaderDeps {
  readonly chain: ProviderChain;
  readonly registry: AssetSink;
  readonly types: TypeSource;
}

// ---------------------------------------------------------------------------
// Small helpers over untrusted JSON
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A `when` that can never pass.
 *
 * Substituted for a MALFORMED `when`, and the choice of value is the whole
 * point. types.ts states the asymmetry: content that stays hidden because a test
 * was misspelled is a missing quest, and content that appears because a test was
 * misspelled is a spoiler or a soft-lock. So a `when` we could not understand
 * must mean NEVER, and dropping the field — which would mean "always" — is the
 * one thing that must not happen.
 *
 * Written as an unknown test rather than as `{ not: { all: [] } }` because the
 * contract guarantees this one: "an unknown `test` is a VALIDATION ERROR and
 * evaluates to false". The empty-`all` spelling would instead depend on the
 * evaluator agreeing that all-of-nothing is true, which is a convention and not
 * a promise. The colon makes it a name no author could register by accident, and
 * it reads as itself in the validator's diagnostic.
 */
const NEVER: Condition = { test: 'content:malformed-when' };

/**
 * The top-level keys the ENVELOPE owns. Everything else belongs under `data`.
 *
 * `pkg`, `source` and `refs` are deliberately absent: the loader sets those
 * three, they are never authored (types.ts says so of each), and an authored one
 * is a misunderstanding worth naming rather than silently overwriting.
 */
const ENVELOPE: ReadonlySet<string> = new Set([
  'id',
  'type',
  'schema',
  'name',
  'description',
  'tags',
  'when',
  'custom',
  'editor',
  'data',
]);

/**
 * Freeze a parsed body all the way down.
 *
 * Content definitions are immutable (spec §12.3) and gameplay holds references
 * to them for the life of a session, so "the engine mutated a definition" is a
 * bug that survives a save and reappears as a corrupted world. Freezing makes it
 * a `TypeError` in strict mode at the moment it happens instead.
 *
 * THIS RUNS ONCE PER ASSET AT LOAD AND NEVER PER FRAME — the walk is O(the
 * body), which is nothing at a zone edge and would be unacceptable in `update`.
 * The `seen` set is not paranoia: a parser may legitimately return a body whose
 * nodes point back at their parent, and a naive recursion into that never ends.
 */
function deepFreeze(value: unknown, seen: WeakSet<object>): void {
  if (typeof value !== 'object' || value === null) return;
  if (seen.has(value)) return;
  seen.add(value);
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const child of value) deepFreeze(child, seen);
    return;
  }
  for (const child of Object.values(value)) deepFreeze(child, seen);
}

/**
 * A structural check on a `Condition` — shape only, never test NAMES.
 *
 * Whether `flag` is a registered test is conditions.ts's question and is asked
 * against a table this file does not own; whether the thing is an object with
 * one of four recognised shapes is a question about the JSON, and the JSON is
 * what arrives here. The depth guard is the same defence as the HTTP provider's:
 * this is a recursive walk, so it must not be the overflow it exists to prevent.
 */
function isConditionShape(v: unknown, depth = 0): v is Condition {
  if (depth > 64 || !isRecord(v)) return false;
  if (Array.isArray(v.all)) return v.all.every((c) => isConditionShape(c, depth + 1));
  if (Array.isArray(v.any)) return v.any.every((c) => isConditionShape(c, depth + 1));
  if ('not' in v) return isConditionShape(v.not, depth + 1);
  return typeof v.test === 'string' && v.test !== '';
}

/**
 * Read a `ContentText`, or null when the field is absent or unusable.
 *
 * The `key` form carries ONE cast in the whole content runtime, and it is here
 * on purpose. `StringKey` is `keyof typeof en`, so the only way to check a key
 * at runtime is against the base table — which is validate.ts's job, because it
 * is the module that may import the table and because a missing key is a
 * cross-cutting finding rather than a reason to refuse an asset. What this can
 * check is the SHAPE, and it does.
 */
function readText(v: unknown): ContentText | null {
  if (!isRecord(v)) return null;
  if (typeof v.key === 'string' && v.key !== '') return { key: v.key } as ContentText;
  if (isRecord(v.text)) {
    const out: Record<string, string> = {};
    for (const [lang, s] of Object.entries(v.text)) if (typeof s === 'string') out[lang] = s;
    if (Object.keys(out).length > 0) return { text: out };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bookkeeping
// ---------------------------------------------------------------------------

interface LoadedPackage {
  readonly id: PackageId;
  readonly version?: string;
  readonly source: string;
  readonly assets: ContentId[];
  /** What the manifest DECLARED, as it loaded. This is what `PackageInfo` shows. */
  readonly requires: PackageId[];
  /**
   * What we placed a dependent-hold on — the declared `requires` AND the
   * `optional` ones that turned out to be there.
   *
   * Two fields rather than one because they answer different questions, and
   * conflating them leaks: releasing only the declared `requires` would leave a
   * loaded optional package held by a dependent that no longer exists, i.e. a
   * package that can never unload. `requires` is what an author wrote; this is
   * what the loader owes a release to.
   */
  readonly holds: PackageId[];
  /** Named holders (spec §12.4) — a leak reads as "zone still holds this". */
  readonly leases: Set<Lease>;
  /** Packages that hold this one open because they depend on it. */
  readonly dependents: Set<PackageId>;
}

/** How a load was asked for: a named lease, or another package's dependency. */
type Hold = { readonly lease: Lease } | { readonly dependent: PackageId };

// ---------------------------------------------------------------------------
// The loader
// ---------------------------------------------------------------------------

export class PackageLoader {
  private readonly chain: ProviderChain;
  private readonly registry: AssetSink;
  private readonly types: TypeSource;

  private readonly loaded = new Map<PackageId, LoadedPackage>();
  private readonly inflight = new Map<PackageId, Promise<LoadResult>>();
  /**
   * pkg -> the ONE package its depth-first walk is currently waiting on.
   *
   * Single-valued because `requires` are resolved sequentially, and they are
   * resolved sequentially because registry insertion order is load order and
   * `ContentLookup.all` promises "in load order" — parallelising the dependency
   * fan-out would make that order a race. This map is what turns a cross-call
   * cycle from a hang into a sentence.
   */
  private readonly blockedOn = new Map<PackageId, PackageId>();
  private readonly log: Diagnostic[] = [];

  constructor(deps: PackageLoaderDeps) {
    this.chain = deps.chain;
    this.registry = deps.registry;
    this.types = deps.types;
  }

  /** Everything found so far, in the order it was found. */
  get diagnostics(): readonly Diagnostic[] {
    return this.log;
  }

  get packages(): readonly PackageInfo[] {
    return [...this.loaded.values()].map((p) => ({
      id: p.id,
      version: p.version,
      source: p.source,
      assets: [...p.assets],
      requires: [...p.requires],
      leases: [...p.leases],
    }));
  }

  isLoaded(pkg: PackageId): boolean {
    return this.loaded.has(pkg);
  }

  /** Load a package and its dependencies under a lease. Idempotent. */
  load(pkg: PackageId, lease: Lease = 'boot'): Promise<LoadResult> {
    return this.resolve(pkg, { lease }, []);
  }

  /**
   * Drop a lease. The package unloads when its last HOLD goes — which is its
   * last lease AND its last dependent, since a package another package requires
   * is still needed however few leases name it directly.
   */
  release(pkg: PackageId, lease: Lease = 'boot'): void {
    const entry = this.loaded.get(pkg);
    if (entry === undefined) return;
    entry.leases.delete(lease);
    this.collect(pkg);
  }

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  private async resolve(
    pkg: PackageId,
    hold: Hold,
    chain: readonly PackageId[],
    optional = false,
  ): Promise<LoadResult> {
    if (!isPackageId(pkg)) {
      return this.refuse(pkg, {
        severity: 'error',
        code: 'bad-package-id',
        message: `"${String(pkg)}" is not a package id`,
        fix: 'lower-case letters, digits and hyphens; no colon, dot or slash',
      });
    }

    // (a) A cycle inside THIS walk. Checked before anything can await, so the
    //     answer is a diagnostic naming both ends rather than a recursion.
    const back = chain[chain.length - 1];
    if (chain.includes(pkg)) {
      return this.refuse(pkg, {
        severity: 'fatal',
        code: 'package-cycle',
        message: `package "${back}" requires "${pkg}", which already requires it (${[...chain, pkg].join(' -> ')})`,
        pkg,
        fix: `break the cycle: move the shared assets into a third package both can require`,
      });
    }

    const already = this.loaded.get(pkg);
    if (already !== undefined) {
      this.hold(already, hold);
      return { pkg, loaded: false, assets: [...already.assets], diagnostics: [] };
    }

    const pending = this.inflight.get(pkg);
    if (pending !== undefined) {
      // (b) A cycle ACROSS two concurrent loads: the package we are about to
      //     wait for is itself (transitively) waiting for one of ours. Awaiting
      //     would deadlock — no throw, no stack, just a promise that never
      //     settles, which is why this check cannot be left to (a).
      const at = this.deadlock(pkg, chain);
      if (at !== null) {
        return this.refuse(pkg, {
          severity: 'fatal',
          code: 'package-cycle',
          message: `package "${back ?? pkg}" and "${at}" require each other across concurrent loads`,
          pkg,
          fix: 'break the cycle: move the shared assets into a third package both can require',
        });
      }
      const shared = await pending;
      const entry = this.loaded.get(pkg);
      if (entry !== undefined) this.hold(entry, hold);
      // `loaded: false` for a joiner: exactly one caller may claim to have
      // loaded a package, and it is the one that started the work.
      return { ...shared, loaded: false };
    }

    const run = this.perform(pkg, hold, chain, optional);
    this.inflight.set(pkg, run);
    try {
      return await run;
    } finally {
      this.inflight.delete(pkg);
      this.blockedOn.delete(pkg);
    }
  }

  /** Walk the wait graph from `target`; return the chain member it reaches, if any. */
  private deadlock(target: PackageId, chain: readonly PackageId[]): PackageId | null {
    const seen = new Set<PackageId>();
    let at: PackageId | undefined = target;
    while (at !== undefined && !seen.has(at)) {
      if (chain.includes(at)) return at;
      seen.add(at);
      at = this.blockedOn.get(at);
    }
    return null;
  }

  private async perform(
    pkg: PackageId,
    hold: Hold,
    chain: readonly PackageId[],
    isOptional: boolean,
  ): Promise<LoadResult> {
    const diagnostics: Diagnostic[] = [];
    const read = await this.chain.read(pkg);
    if (read === null) {
      // ONE diagnostic for one problem, and its severity is the whole
      // difference between `requires` and `optional`. Reported HERE rather than
      // by the caller because the caller would be adding a second finding on top
      // of this one — and because an absent optional package logged as an
      // `error` would fail a build check for content that is legitimately not
      // shipped yet. The requester's name comes from the hold, which is the only
      // reason `perform` is given it.
      const by = 'dependent' in hold ? ` (needed by "${hold.dependent}")` : '';
      return this.refuse(pkg, {
        severity: isOptional ? 'warn' : 'error',
        code: isOptional ? 'missing-optional' : 'package-not-found',
        message: `no provider has package "${pkg}"${by}`,
        pkg,
        fix: isOptional
          ? 'nothing, if it is meant to be absent'
          : 'check the id, or add a provider that serves it',
      });
    }

    const raw = read.value;
    if (!isRecord(raw)) {
      // FATAL rather than error: there is no partial answer to give. The
      // difference matters for the core package, which the game cannot run
      // without (types.ts, on Severity).
      return this.refuse(pkg, {
        severity: 'fatal',
        code: 'bad-package',
        message: `package "${pkg}" is not a JSON object`,
        pkg,
        source: read.source,
      });
    }

    if (typeof raw.id === 'string' && raw.id !== pkg) {
      diagnostics.push(
        this.note({
          severity: 'warn',
          code: 'package-id-mismatch',
          message: `package at "${read.source}" calls itself "${raw.id}" but was requested as "${pkg}"`,
          pkg,
          source: read.source,
          fix: `rename the file to "${raw.id}.json" or change its "id"`,
        }),
      );
    }

    const nextChain = [...chain, pkg];
    const requires = this.idList(raw.requires);
    const optional = this.idList(raw.optional);

    // 1. Hard dependencies, then 2. soft ones — depth-first and IN ORDER, see
    //    the header. The only difference between the two lists is the `optional`
    //    flag, which decides the severity of an absence and nothing else.
    for (const [dep, soft] of [
      ...requires.map((d) => [d, false] as const),
      ...optional.map((d) => [d, true] as const),
    ]) {
      this.blockedOn.set(pkg, dep);
      const res = await this.resolve(dep, { dependent: pkg }, nextChain, soft);
      this.blockedOn.delete(pkg);
      diagnostics.push(...res.diagnostics);
    }

    const entry: LoadedPackage = {
      id: pkg,
      version: typeof raw.version === 'string' ? raw.version : undefined,
      source: read.source,
      assets: [],
      requires: requires.filter((d) => this.loaded.has(d)),
      holds: [...requires, ...optional].filter((d) => this.loaded.has(d)),
      leases: new Set<Lease>(),
      dependents: new Set<PackageId>(),
    };

    // 3. Inline assets, then each named file.
    if (raw.assets !== undefined) {
      if (Array.isArray(raw.assets)) {
        raw.assets.forEach((body, i) => {
          const id = this.ingest(body, pkg, `${read.source}#${i}`, diagnostics);
          if (id !== null) entry.assets.push(id);
        });
      } else {
        diagnostics.push(
          this.note({
            severity: 'error',
            code: 'bad-field',
            message: `package "${pkg}" has a non-array "assets"`,
            pkg,
            source: read.source,
            field: 'assets',
          }),
        );
      }
    }

    for (const file of this.stringList(raw.files)) {
      const sub = await this.chain.read(pkg, file);
      if (sub === null) {
        diagnostics.push(
          this.note({
            severity: 'error',
            code: 'file-not-found',
            message: `package "${pkg}" names file "${file}", which no provider has`,
            pkg,
            source: read.source,
            field: 'files',
          }),
        );
        continue;
      }
      // A file is either a bare array of assets or `{ "assets": [...] }` — the
      // second so a file can grow a header later without every reader changing.
      const bodies = Array.isArray(sub.value)
        ? sub.value
        : isRecord(sub.value) && Array.isArray(sub.value.assets)
          ? sub.value.assets
          : null;
      if (bodies === null) {
        diagnostics.push(
          this.note({
            severity: 'error',
            code: 'bad-file',
            message: `file "${file}" of package "${pkg}" is neither an array of assets nor { "assets": [...] }`,
            pkg,
            source: sub.source,
          }),
        );
        continue;
      }
      bodies.forEach((body, i) => {
        const id = this.ingest(body, pkg, `${sub.source}#${i}`, diagnostics);
        if (id !== null) entry.assets.push(id);
      });
    }

    this.loaded.set(pkg, entry);
    this.hold(entry, hold);
    return { pkg, loaded: true, assets: [...entry.assets], diagnostics };
  }

  // -------------------------------------------------------------------------
  // One authored body -> one frozen ContentAsset
  // -------------------------------------------------------------------------

  private ingest(
    body: unknown,
    pkg: PackageId,
    source: string,
    out: Diagnostic[],
  ): ContentId | null {
    const fail = (d: Omit<Diagnostic, 'pkg' | 'source'>): null => {
      out.push(this.note({ ...d, pkg, source }));
      return null;
    };

    if (!isRecord(body)) {
      return fail({ severity: 'error', code: 'bad-asset', message: 'asset is not a JSON object' });
    }
    const id = body.id;
    if (!isId(id)) {
      return fail({
        severity: 'error',
        code: 'bad-id',
        message: `"${String(id)}" is not a content id`,
        field: 'id',
        fix: 'ids are "<type>:<name>", lower-case [a-z0-9-]',
      });
    }
    // The type is INSIDE the id and is therefore never authored twice — see the
    // note on `ContentId` in types.ts. `typeOf` cannot fail after `isId`.
    const type = typeOf(id) as ContentTypeName;

    const def = this.types.type(type);
    if (def === undefined) {
      // Skipped, not thrown: an unregistered type is one broken asset, and the
      // rest of the package is still worth having (spec §21, fail predictably).
      return fail({
        severity: 'error',
        code: 'unknown-type',
        message: `no content type "${type}" is registered`,
        assetId: id,
        assetType: type,
        fix: `call defineType({ name: "${type}", ... }) before loading "${pkg}"`,
      });
    }

    if (this.registry.has(id)) {
      return fail({
        severity: 'error',
        code: 'duplicate-id',
        message: `"${id}" is already defined`,
        assetId: id,
        assetType: type,
        related: [id],
        fix: 'ids are global; rename one of them',
      });
    }

    // SCHEMA. An absent revision means CURRENT, not 1: content authored inside
    // this repo ships with the build that defines the type, and replaying a
    // migration chain over already-current data is a worse failure than skipping
    // migrations that were never needed. Content from outside the build states
    // its revision, which is what `schema` is for.
    const authored = typeof body.schema === 'number' && Number.isFinite(body.schema)
      ? body.schema
      : def.schema;

    // THE TYPE BODY LIVES UNDER `data`, and that is forced by the contract
    // rather than chosen: `ContentTypeDef.serialize(data)` is given only the
    // parsed body and must round-trip `parse`, so `parse` can only ever have
    // been handed that same body — a shape with the envelope and the body
    // flattened together could not be rebuilt from `data` alone.
    //
    // So authoring it flat is NAMED rather than half-accepted. Parsing `{}` in
    // its place would succeed for any type whose fields are optional and produce
    // an asset with none of the author's work in it, which is the failure that
    // gets found weeks later in a world with a nameless town in it.
    const strays = Object.keys(body).filter((k) => !ENVELOPE.has(k));
    if (body.data === undefined && strays.length > 0) {
      return fail({
        severity: 'error',
        code: 'body-not-wrapped',
        message: `"${id}" has no "data", and ${strays.map((s) => `"${s}"`).join(', ')} look like a ${type} body`,
        assetId: id,
        assetType: type,
        fix: 'wrap the type-specific fields in "data": { ... }',
      });
    }
    if (strays.length > 0) {
      out.push(
        this.note({
          severity: 'info',
          code: 'unknown-field',
          message: `"${id}" has unrecognised top-level ${strays.length === 1 ? 'field' : 'fields'} ${strays.map((s) => `"${s}"`).join(', ')}`,
          assetId: id,
          assetType: type,
          pkg,
          source,
          fix: 'move them under "data", or under "custom" as "<namespace>.<field>"',
        }),
      );
    }

    let raw: unknown = body.data === undefined ? {} : body.data;

    if (authored > def.schema) {
      // Skipped rather than guessed. A body written against a LATER revision may
      // use fields with meanings this build does not have, and half-understanding
      // it is how a save ends up holding a state nothing can interpret.
      return fail({
        severity: 'error',
        code: 'schema-too-new',
        message: `"${id}" is schema ${authored}; this build understands ${type} up to ${def.schema}`,
        assetId: id,
        assetType: type,
        fix: 'update the game, or re-author the asset against the older schema',
      });
    }
    if (authored < def.schema) {
      if (def.migrate === undefined) {
        out.push(
          this.note({
            severity: 'warn',
            code: 'no-migration',
            message: `"${id}" is schema ${authored}, current is ${def.schema}, and ${type} has no migrate()`,
            assetId: id,
            assetType: type,
            pkg,
            source,
          }),
        );
      } else {
        try {
          raw = def.migrate(raw, authored);
        } catch (e) {
          return fail({
            severity: 'error',
            code: 'migrate-failed',
            message: `migrating "${id}" from schema ${authored}: ${e instanceof Error ? e.message : String(e)}`,
            assetId: id,
            assetType: type,
          });
        }
      }
    }

    // PARSE. The type reports recoverable problems through `ctx.report` and
    // returns null only when the body cannot make a usable asset at all; a throw
    // is treated as that same answer rather than allowed to abort the package.
    const ctx: ParseCtx = {
      assetId: id,
      source,
      report: (d) =>
        out.push(
          this.note({
            ...d,
            assetId: id,
            assetType: d.assetType ?? type,
            pkg: d.pkg ?? pkg,
            source,
          }),
        ),
    };
    let data: unknown;
    try {
      data = def.parse(raw, ctx);
    } catch (e) {
      return fail({
        severity: 'error',
        code: 'parse-threw',
        message: `parsing "${id}": ${e instanceof Error ? e.message : String(e)}`,
        assetId: id,
        assetType: type,
      });
    }
    if (data === null || data === undefined) {
      return fail({
        severity: 'error',
        code: 'unparseable',
        message: `"${id}" could not be parsed as a ${type}`,
        assetId: id,
        assetType: type,
      });
    }

    // REFS ARE EXTRACTED, NEVER AUTHORED (types.ts, spec §4.3) — a hand-kept
    // list is a list somebody forgets, and the reverse-reference graph is only
    // complete if this one is.
    const refs: ContentId[] = [];
    if (def.refs !== undefined) {
      try {
        const seen = new Set<ContentId>();
        for (const ref of def.refs(data)) {
          if (!isId(ref)) {
            out.push(
              this.note({
                severity: 'error',
                code: 'bad-ref',
                message: `"${id}" points at "${String(ref)}", which is not a content id`,
                assetId: id,
                assetType: type,
                pkg,
                source,
              }),
            );
            continue;
          }
          if (seen.has(ref)) continue;
          seen.add(ref);
          refs.push(ref);
        }
      } catch (e) {
        out.push(
          this.note({
            severity: 'error',
            code: 'refs-threw',
            message: `extracting refs of "${id}": ${e instanceof Error ? e.message : String(e)}`,
            assetId: id,
            assetType: type,
            pkg,
            source,
          }),
        );
      }
    }

    let when: Condition | undefined;
    if (body.when !== undefined) {
      if (isConditionShape(body.when)) {
        when = body.when;
      } else {
        when = NEVER;
        out.push(
          this.note({
            severity: 'error',
            code: 'bad-when',
            message: `"${id}" has a malformed "when"; it is treated as never available`,
            assetId: id,
            assetType: type,
            pkg,
            source,
            field: 'when',
            fix: 'a condition is { all: [...] }, { any: [...] }, { not: {...} } or { test: "name", ... }',
          }),
        );
      }
    }

    const tags: string[] = [];
    if (Array.isArray(body.tags)) {
      for (const tag of body.tags) if (typeof tag === 'string' && tag !== '') tags.push(tag);
    } else if (body.tags !== undefined) {
      out.push(
        this.note({
          severity: 'warn',
          code: 'bad-field',
          message: `"${id}" has a non-array "tags"`,
          assetId: id,
          assetType: type,
          pkg,
          source,
          field: 'tags',
        }),
      );
    }

    const custom: Record<string, unknown> = {};
    if (isRecord(body.custom)) {
      for (const [key, value] of Object.entries(body.custom)) {
        // Keys are `<namespace>.<field>` (spec §6.2). An un-namespaced key is
        // kept — the point of this bag is that nothing it holds is silently
        // deleted — but it is named, because the namespace is what stops two
        // tools claiming one field.
        if (!key.includes('.')) {
          out.push(
            this.note({
              severity: 'info',
              code: 'custom-key',
              message: `"${id}" has custom field "${key}" with no namespace`,
              assetId: id,
              assetType: type,
              pkg,
              source,
              field: `custom.${key}`,
              fix: 'name it "<namespace>.<field>"',
            }),
          );
        }
        custom[key] = value;
      }
    }

    const name = readText(body.name);
    const description = readText(body.description);

    const asset: ContentAsset = {
      id,
      type,
      schema: def.schema,
      pkg,
      source,
      ...(name === null ? {} : { name }),
      ...(description === null ? {} : { description }),
      tags,
      ...(when === undefined ? {} : { when }),
      refs,
      custom,
      ...(isRecord(body.editor) ? { editor: body.editor } : {}),
      data,
    };

    const seen = new WeakSet<object>();
    deepFreeze(asset.data, seen);
    deepFreeze(asset.refs, seen);
    deepFreeze(asset.tags, seen);
    deepFreeze(asset.custom, seen);
    if (asset.when !== undefined) deepFreeze(asset.when, seen);
    Object.freeze(asset);

    this.registry.add(asset);
    return id;
  }

  // -------------------------------------------------------------------------
  // Unloading
  // -------------------------------------------------------------------------

  private hold(entry: LoadedPackage, hold: Hold): void {
    if ('lease' in hold) entry.leases.add(hold.lease);
    else entry.dependents.add(hold.dependent);
  }

  /**
   * Unload if nothing holds it, then reconsider everything it held.
   *
   * DEFINITIONS UNLOAD; STATE PERSISTS. Nothing in here touches `ContentState` —
   * see the header. The registry loses the assets, the flags and quest statuses
   * keyed by those ids do not move, and loading the package again makes the same
   * facts mean the same thing.
   */
  private collect(pkg: PackageId): void {
    const entry = this.loaded.get(pkg);
    if (entry === undefined) return;
    if (entry.leases.size > 0 || entry.dependents.size > 0) return;

    for (const id of entry.assets) this.registry.remove(id);
    this.loaded.delete(pkg);

    // Recursion depth is the depth of the dependency graph — a handful, and
    // bounded by the cycle check that made it a DAG in the first place.
    for (const dep of entry.holds) {
      const held = this.loaded.get(dep);
      if (held === undefined) continue;
      held.dependents.delete(pkg);
      this.collect(dep);
    }
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  /** Record and return, so a caller can push the same object into its result. */
  private note(d: Diagnostic): Diagnostic {
    this.log.push(d);
    return d;
  }

  private refuse(pkg: PackageId, d: Diagnostic): LoadResult {
    return { pkg, loaded: false, assets: [], diagnostics: [this.note(d)] };
  }

  private idList(v: unknown): PackageId[] {
    return this.stringList(v).filter(isPackageId);
  }

  private stringList(v: unknown): string[] {
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
  }
}
