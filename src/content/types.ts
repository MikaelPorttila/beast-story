/**
 * Contract hub for game content — issue #60, spec v0.1. Interfaces only, no work.
 * Content carries no code: behaviour is SELECTED by name, so remote JSON cannot
 * inject a script. Nothing the frame loop calls is async, and `core.json` is a
 * module import so the starting world needs no fetch.
 */

import type { StringKey } from "../i18n";

/**
 * `"<type>:<name>"`, never a path or position (spec §4.2). Saves store these, so a
 * rename is a migration. Type is in the id, package deliberately is not; bare
 * `string` since it comes from JSON, format enforced at runtime by `parseId`.
 */
export type ContentId = string;

export type PackageId = string;

export type ContentTypeName = string;

/** `{ key }` = shipped table, checked at build time; `{ text }` = authored outside
 * the build. Resolve only through `resolveText`. */
export type ContentText =
  | { readonly key: StringKey }
  | { readonly text: Readonly<Record<string, string>> };

/** Spec §8.3: combinators plus a leaf naming a REGISTERED test, params flat beside
 * it. An unknown `test` is FALSE — wrongly shown content is a spoiler or soft-lock. */
export type Condition =
  | { readonly all: readonly Condition[] }
  | { readonly any: readonly Condition[] }
  | { readonly not: Condition }
  | ({ readonly test: string } & Readonly<Record<string, unknown>>);

/** Registered state change or gameplay call (spec §8.4), e.g. `{ "do": "flag.set" }`. */
export type Action = { readonly do: string } & Readonly<Record<string, unknown>>;

export interface EvalCtx {
  readonly state: ContentState;
  readonly content: ContentLookup;
}

/** Pure: may read state, never write it. */
export type ConditionTest = (params: Readonly<Record<string, unknown>>, ctx: EvalCtx) => boolean;

export type ActionHandler = (params: Readonly<Record<string, unknown>>, ctx: EvalCtx) => void;

/** Spec §6. This record and `data` are FROZEN by the loader; per-session state
 * belongs in `ContentState`. */
export interface ContentAsset<T = unknown> {
  readonly id: ContentId;
  /** Derived from `id`; never authored. */
  readonly type: ContentTypeName;
  readonly schema: number;
  /** Set by the loader, never authored. */
  readonly pkg: PackageId;
  /** For diagnostics — `bundled:core#3`, `http:…/quests.json`. */
  readonly source: string;
  readonly name?: ContentText;
  readonly description?: ContentText;
  readonly tags: readonly string[];
  /** Absent means "always". Evaluated against live state. */
  readonly when?: Condition;
  /** EXTRACTED by the type's `refs()`, so the graph is complete (spec §4.3, §14.2). */
  readonly refs: readonly ContentId[];
  /** `<namespace>.<field>` keys, preserved verbatim so unknown fields survive a save. */
  readonly custom: Readonly<Record<string, unknown>>;
  /** Never read by gameplay. */
  readonly editor?: Readonly<Record<string, unknown>>;
  readonly data: T;
}

export interface ContentLookup {
  get<T = unknown>(id: ContentId): ContentAsset<T> | undefined;
  all<T = unknown>(type: ContentTypeName): readonly ContentAsset<T>[];
  has(id: ContentId): boolean;
}

/** A parser REPORTS rather than throws, so one bad field still loads the package. */
export interface ParseCtx {
  readonly assetId: ContentId;
  readonly source: string;
  /** `field` is a dotted path inside the asset body. */
  report(d: Omit<Diagnostic, "assetId" | "source"> & { field?: string }): void;
}

/** Spec §6.3: a new type is a registration, not a loader change. */
export interface ContentTypeDef<T = unknown> {
  readonly name: ContentTypeName;
  /** An asset authored older goes through `migrate`. */
  readonly schema: number;
  /** Null when the body is unusable — the loader skips the asset, keeps the package. */
  parse(body: unknown, ctx: ParseCtx): T | null;
  /** After a whole load. Ref existence is checked centrally; this is type-only rules. */
  validate?(asset: ContentAsset<T>, ctx: ValidateCtx): void;
  refs?(data: T): Iterable<ContentId>;
  /** Must round-trip `parse`. */
  serialize?(data: T): unknown;
  migrate?(body: unknown, from: number): unknown;
  /** A valid, obviously-unfinished starting point (spec §16.3). */
  readonly template?: unknown;
}

export interface ValidateCtx {
  readonly content: ContentLookup;
  report(d: Omit<Diagnostic, "assetId"> & { assetId?: ContentId }): void;
}

/** `error` is survivable content, `fatal` is not; a build check fails on errors. */
export type Severity = "info" | "warn" | "error" | "fatal";

export interface Diagnostic {
  readonly severity: Severity;
  /** Stable machine code — `missing-ref`, `duplicate-id`, `bad-field`. */
  readonly code: string;
  readonly message: string;
  readonly assetId?: ContentId;
  readonly assetType?: ContentTypeName;
  readonly pkg?: PackageId;
  readonly source?: string;
  readonly field?: string;
  readonly fix?: string;
  readonly related?: readonly ContentId[];
}

/** Assets inline, or `files` naming siblings to fetch (spec §14). Core uses inline. */
export interface RawPackage {
  readonly id: PackageId;
  readonly version?: string;
  readonly requires?: readonly PackageId[];
  readonly optional?: readonly PackageId[];
  readonly assets?: readonly unknown[];
  readonly files?: readonly string[];
  readonly meta?: Readonly<Record<string, unknown>>;
}

/** Spec §13. The runtime never knows whether an asset was bundled, fetched or cached. */
export interface StorageProvider {
  readonly name: string;
  /** Higher wins when two providers offer the same package (spec §13.2). */
  readonly priority: number;
  readonly writable: boolean;
  list(): Promise<readonly PackageId[]>;
  /** No `file` = the package's own JSON. Null is "not here" — falls through to the
   * next provider, not an error. */
  read(pkg: PackageId, file?: string): Promise<unknown | null>;
  /** Only when `writable`. Saving elsewhere must fail loudly (spec §13.1). */
  write?(pkg: PackageId, file: string | undefined, value: unknown): Promise<void>;
}

/** Who holds a package open (spec §12.4) — named so a leak is attributable. `boot` is never released. */
export type Lease = "boot" | "zone" | "quest" | "dialogue" | "event" | "editor" | "debug";

export interface LoadResult {
  readonly pkg: PackageId;
  /** False when the package was already loaded and this only added a lease. */
  readonly loaded: boolean;
  readonly assets: readonly ContentId[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface PackageInfo {
  readonly id: PackageId;
  readonly version?: string;
  readonly source: string;
  readonly assets: readonly ContentId[];
  readonly requires: readonly PackageId[];
  readonly leases: readonly Lease[];
}

/** The save boundary (spec §8.2, §20). Facts as ids, never indices: availability is
 * recomputed from completed ids and flags, so inserting a quest into an existing
 * line cannot move a player backward (spec §9.3). */
export interface ContentState {
  flag(name: string): boolean;
  setFlag(name: string, on: boolean): void;
  readonly flags: readonly string[];

  questStatus(id: ContentId): QuestStatus;
  setQuestStatus(id: ContentId, status: QuestStatus): void;
  readonly activeQuests: readonly ContentId[];
  readonly completedQuests: readonly ContentId[];

  progress(quest: ContentId, objective: string): number;
  setProgress(quest: ContentId, objective: string, n: number): void;

  discovered(id: ContentId): boolean;
  discover(id: ContentId): void;

  /** Fires after any mutation, so conditions can be re-evaluated once. */
  onChange(fn: (what: StateChange) => void): () => void;

  /** Plain JSON — no class instances, no undefined. */
  toJSON(): unknown;
  /** Unknown fields are preserved. */
  fromJSON(value: unknown): void;
  reset(): void;
}

export type QuestStatus = "unknown" | "available" | "active" | "completed" | "failed";

export interface StateChange {
  readonly kind: "flag" | "quest" | "progress" | "discovery" | "reset";
  readonly name: string;
}

/** Spec §18.2, §19. Reverse lookup needs an index — files cannot answer it. */
export interface ContentQuery {
  refs(id: ContentId): readonly ContentId[];
  /** Ids that point AT this asset. */
  referrers(id: ContentId): readonly ContentId[];
  reachable(root: ContentId): readonly ContentId[];
  /** Assets carrying EVERY one of these tags. */
  byTag(...tags: readonly string[]): readonly ContentAsset[];
  /** Substring match over id, tags and resolved display name. */
  search(text: string, type?: ContentTypeName): readonly ContentAsset[];
  /** Loaded assets of a type whose `when` passes against current state. */
  available<T = unknown>(type: ContentTypeName): readonly ContentAsset<T>[];
  /** Referenced by loaded content, defined by no loaded asset. */
  dangling(): readonly ContentId[];
  /** Nothing points at them and no system enumerates them by type. */
  orphans(): readonly ContentId[];
}

/** The one object the game holds; nothing outside `src/content/` builds the pieces. */
export interface ContentRuntime extends ContentLookup {
  readonly state: ContentState;
  readonly query: ContentQuery;

  defineType<T>(def: ContentTypeDef<T>): void;
  defineTest(name: string, fn: ConditionTest): void;
  defineAction(name: string, fn: ActionHandler): void;
  /** A behaviour content may SELECT — keyed `<kind>/<name>`, e.g. `npc-body/gain`. */
  defineFactory(kind: string, name: string, value: unknown): void;
  factory<V = unknown>(kind: string, name: string): V | undefined;

  addProvider(p: StorageProvider): void;

  /** Loads dependencies too. Idempotent. */
  load(pkg: PackageId, lease?: Lease): Promise<LoadResult>;
  /** The package unloads when its last lease goes (spec §12.3). */
  release(pkg: PackageId, lease?: Lease): void;
  onDefinitionsChange(fn: () => void): () => void;
  readonly packages: readonly PackageInfo[];

  /** Against live state. A missing/unknown test is false. */
  evaluate(when: Condition | undefined): boolean;
  /** In order. Unknown actions are reported and skipped. */
  run(actions: readonly Action[] | undefined): void;

  diagnostics(): readonly Diagnostic[];
}
