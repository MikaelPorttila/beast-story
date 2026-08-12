// The only async part of the content runtime; never called per frame.
// Load order is load-bearing: `requires` depth-first FIRST (so a cross-package ref is
// not dangling when it is extracted), then `optional` (absent is only a warning), then
// inline `assets`, then `files`.
// A cycle is a DIAGNOSTIC: within one walk via `chain`, across concurrent loads via
// `blockedOn` — the second would otherwise never settle. Overlapping loads share one
// promise, or two parses would race and report `duplicate-id`.
// UNLOADING DROPS DEFINITIONS AND NEVER TOUCHES PLAYER STATE: state is keyed by id.

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

// A contract, not an import of registry.ts, so this file tests against a stub. `has`
// rather than a reporting `add`: only the loader knows the package, source and index.
export interface AssetSink {
  add(asset: ContentAsset): void;
  remove(id: ContentId): void;
  has(id: ContentId): boolean;
}

export interface TypeSource {
  type(name: ContentTypeName): ContentTypeDef | undefined;
}

export interface PackageLoaderDeps {
  readonly chain: ProviderChain;
  readonly registry: AssetSink;
  readonly types: TypeSource;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Substituted for a MALFORMED `when`, since dropping the field would mean "always".
// An unknown test is CONTRACTUALLY false; an empty `all` is only a convention.
const NEVER: Condition = { test: 'content:malformed-when' };

/** Everything else belongs under `data`. The loader sets `pkg`/`source`/`refs`. */
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

// Definitions are immutable, so a mutation is a TypeError where it happens. Once per
// asset. `seen` is required: a parsed body may point back at its parent.
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

/** Shape only, never test NAMES. Depth-guarded: this walk is recursive. */
function isConditionShape(v: unknown, depth = 0): v is Condition {
  if (depth > 64 || !isRecord(v)) return false;
  if (Array.isArray(v.all)) return v.all.every((c) => isConditionShape(c, depth + 1));
  if (Array.isArray(v.any)) return v.any.every((c) => isConditionShape(c, depth + 1));
  if ('not' in v) return isConditionShape(v.not, depth + 1);
  return typeof v.test === 'string' && v.test !== '';
}

/** SHAPE only: a key's membership needs the string table, which validate.ts owns. */
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

interface LoadedPackage {
  readonly id: PackageId;
  readonly version?: string;
  readonly source: string;
  readonly assets: ContentId[];
  readonly requires: PackageId[];
  /** `requires` PLUS resolved `optional`, or a loaded optional never gets released. */
  readonly holds: PackageId[];
  /** Named holders — a leak reads as "zone still holds this". */
  readonly leases: Set<Lease>;
  readonly dependents: Set<PackageId>;
}

type Hold = { readonly lease: Lease } | { readonly dependent: PackageId };

export class PackageLoader {
  private readonly chain: ProviderChain;
  private readonly registry: AssetSink;
  private readonly types: TypeSource;

  private readonly loaded = new Map<PackageId, LoadedPackage>();
  private readonly inflight = new Map<PackageId, Promise<LoadResult>>();
  /** Single-valued: `requires` resolve sequentially, since `all()` promises load order. */
  private readonly blockedOn = new Map<PackageId, PackageId>();
  private readonly log: Diagnostic[] = [];

  constructor(deps: PackageLoaderDeps) {
    this.chain = deps.chain;
    this.registry = deps.registry;
    this.types = deps.types;
  }

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

  load(pkg: PackageId, lease: Lease = 'boot'): Promise<LoadResult> {
    return this.resolve(pkg, { lease }, []);
  }

  /** Unloads on the last HOLD — last lease AND last dependent. */
  release(pkg: PackageId, lease: Lease = 'boot'): void {
    const entry = this.loaded.get(pkg);
    if (entry === undefined) return;
    entry.leases.delete(lease);
    this.collect(pkg);
  }

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

    // (a) A cycle inside THIS walk, checked before anything can await.
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
      // (b) A cycle ACROSS concurrent loads: awaiting would never settle, which is
      //     why (a) cannot catch it.
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
      // `loaded: false` for a joiner: only the caller that started may claim it.
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
      // Severity is the whole difference between `requires` and `optional`.
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
      // FATAL: there is no partial answer, and the core package must run.
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

    // Hard dependencies, then soft ones — depth-first and IN ORDER.
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
      // Either a bare array or `{ "assets": [...] }`, so a file can grow a header.
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

  /** One authored body -> one frozen ContentAsset. */
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
    // `typeOf` cannot fail after `isId`.
    const type = typeOf(id) as ContentTypeName;

    const def = this.types.type(type);
    if (def === undefined) {
      // Skipped, not thrown: the rest of the package is still worth having.
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

    // An absent revision means CURRENT, not 1: in-repo content ships with the build
    // that defines its type, so replaying migrations over it would be the worse bug.
    const authored = typeof body.schema === 'number' && Number.isFinite(body.schema)
      ? body.schema
      : def.schema;

    // The body MUST live under `data`: `serialize(data)` has to round-trip `parse`.
    // A flat body is NAMED, not half-accepted — parsing `{}` would drop the author's work.
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
      // Skipped, not guessed: a later revision's fields may mean something else here.
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

    // A type returns null only when the body is unusable; a throw means the same,
    // rather than aborting the package.
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

    // Refs are EXTRACTED, never authored, or the reverse graph would be incomplete.
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
        // An un-namespaced key is KEPT — nothing in this bag is silently dropped —
        // but named, since the namespace is what stops two tools claiming one field.
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

  private hold(entry: LoadedPackage, hold: Hold): void {
    if ('lease' in hold) entry.leases.add(hold.lease);
    else entry.dependents.add(hold.dependent);
  }

  // Unload if nothing holds it, then reconsider what it held. DEFINITIONS UNLOAD,
  // STATE PERSISTS: nothing here touches `ContentState`.
  private collect(pkg: PackageId): void {
    const entry = this.loaded.get(pkg);
    if (entry === undefined) return;
    if (entry.leases.size > 0 || entry.dependents.size > 0) return;

    for (const id of entry.assets) this.registry.remove(id);
    this.loaded.delete(pkg);

    // Recursion is bounded by the cycle check that made this a DAG.
    for (const dep of entry.holds) {
      const held = this.loaded.get(dep);
      if (held === undefined) continue;
      held.dependents.delete(pkg);
      this.collect(dep);
    }
  }

  /** Records and returns, so a caller can push the same object. */
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
