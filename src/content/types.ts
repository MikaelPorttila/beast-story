/**
 * THE CONTRACT HUB FOR GAME CONTENT — issue #60, spec v0.1.
 *
 * This file is to `src/content/` what `src/core/types.ts` is to the game: every
 * cross-module interface, and nothing that does any work. Modules in here depend
 * on this file rather than on each other, so the loader never imports the
 * registry's implementation and the validator never imports the loader's.
 *
 * WHAT THIS SYSTEM IS FOR. The engine implements reusable behaviour; JSON
 * describes what exists, where, when it is available, and what happens when the
 * player touches it. A settlement's name, an NPC's placement, an enemy's stats
 * and a quest's prerequisites are CONTENT. Streaming chunks, voxel builders,
 * follow steering and the combat loop are ENGINE. The line is spec §4.1 and it
 * is the one rule the rest of the design falls out of.
 *
 * THREE THINGS THIS DELIBERATELY DOES NOT DO, all of them spec §4.6.
 *
 *   - Content carries no executable code. A behaviour is SELECTED by name from a
 *     registry the engine populates (`appearance: "gain"`, `layout: "camp"`), so
 *     remote JSON can be validated, inspected and migrated, and can never be a
 *     script injection. That is also why a voxel builder stays in TypeScript: it
 *     is behaviour, and only its CHOICE is data.
 *   - Nothing here reaches for the DOM, three.js or the world. The content
 *     runtime is a graph of frozen records plus a state store; the game reads
 *     it, and the reverse dependency does not exist. That is what lets a tool or
 *     a test drive it headless.
 *   - No async in the hot path. Everything the frame loop asks (`get`, `all`,
 *     `evaluate`) is synchronous against already-loaded content, because a
 *     promise per NPC prompt is a frame hitch. Loading is the only async part,
 *     and it happens at a boot phase or a zone edge.
 *
 * THE CORE PACKAGE IS BUNDLED, NOT FETCHED, and that is what makes the issue's
 * hard requirement true: "the initial world should always be able to run without
 * any extra data being loaded". `content/data/core.json` is imported as a module,
 * so it lands in the main chunk beside `main.ts` — there is no request that can
 * fail, no ordering to get wrong, and a build that shipped is a build whose core
 * content shipped. Everything else (a zone, a quest line, a remote pack) is
 * fetched lazily through a `StorageProvider` and may legitimately be absent.
 */

import type { StringKey } from '../i18n';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * A stable content identifier, `"<type>:<name>"` — `town:encampment`,
 * `npc:gain`, `enemy:gloopling`, `quest:first-steps`.
 *
 * STABLE IS THE WHOLE POINT (spec §4.2). A reference is never a file path, an
 * array index, a display name or a load position, because every one of those
 * moves when content is reorganised and an id must not. A save game stores these
 * strings, so renaming one is a migration and not an edit.
 *
 * THE TYPE IS INSIDE THE ID, deliberately. It makes a reference self-describing:
 * a validator can tell that `spawns: ["enemy:gloopling"]` points at the right
 * KIND of thing without loading the target, which is exactly the check that
 * catches a typo pointing at a real asset of the wrong type. It also means an
 * asset's `type` field never has to be authored — see `parseId` in ids.ts.
 *
 * The PACKAGE is NOT inside the id, equally deliberately: spec §4.2 requires an
 * id to survive being moved between packages, and an id that names its package
 * cannot.
 *
 * Kept a bare `string` rather than a branded type: these come out of JSON, and a
 * brand would mean a cast at every parse — the format is enforced at runtime by
 * `parseId`, where the untrusted data actually arrives.
 */
export type ContentId = string;

/** A package identifier: lower-case, `[a-z0-9-]`, e.g. `core`, `zone-dungeon`. */
export type PackageId = string;

/** The `type` half of a `ContentId` — `town`, `npc`, `biome`, `enemy`, `quest`. */
export type ContentTypeName = string;

// ---------------------------------------------------------------------------
// Localised text
// ---------------------------------------------------------------------------

/**
 * A player-visible string carried by content.
 *
 * TWO FORMS, and the reason is the one compile-time guarantee this codebase
 * rests on. `StringKey` is `keyof typeof en`, so every string in the game is
 * checked against the base table at build time — and data authored outside the
 * repo cannot possibly be. So content says which it means:
 *
 *   { "key": "town.encampment.name" }                  <- the shipped table
 *   { "text": { "en": "Redbriar", "sv": "Rödtörne" } } <- carried inline
 *
 * The migrated content uses the first form throughout, so nothing about
 * `src/i18n/en.ts` changes and the existing strings keep their build-time check.
 * The second exists for content that arrives after the build — a remote pack, a
 * quest written by a tool — and falls back across languages the same way `t()`
 * does. Resolution is `resolveText` in content/text.ts; nothing else may reach
 * into either shape.
 */
export type ContentText =
  | { readonly key: StringKey }
  | { readonly text: Readonly<Record<string, string>> };

// ---------------------------------------------------------------------------
// Conditions and actions
// ---------------------------------------------------------------------------

/**
 * A declarative, composable availability test (spec §8.3).
 *
 * Four shapes: three combinators and one leaf. The leaf names a REGISTERED test
 * and carries its parameters flat beside it, which keeps authored JSON readable
 * (`{ "test": "flag", "flag": "met-gain" }`) and keeps the extension point a
 * lookup rather than a `switch` the engine owns.
 *
 * An unknown `test` is a VALIDATION ERROR and evaluates to false. False rather
 * than true because the failure modes are not symmetric: content that stays
 * hidden because a test was misspelled is a missing quest, and content that
 * appears because a test was misspelled is a spoiler or a soft-lock.
 */
export type Condition =
  | { readonly all: readonly Condition[] }
  | { readonly any: readonly Condition[] }
  | { readonly not: Condition }
  | ({ readonly test: string } & Readonly<Record<string, unknown>>);

/**
 * A registered state change or gameplay call (spec §8.4).
 *
 * Same shape as a condition leaf and for the same reasons: `{ "do": "flag.set",
 * "flag": "met-gain" }`. Actions must be explicit, inspectable and validatable —
 * an action list is the thing a reviewer reads to know what a dialogue choice
 * will do to their save.
 */
export type Action = { readonly do: string } & Readonly<Record<string, unknown>>;

/** What a condition test and an action handler are given. */
export interface EvalCtx {
  /** The player's and world's facts. */
  readonly state: ContentState;
  /** Loaded content, for tests that ask about an asset rather than a flag. */
  readonly content: ContentLookup;
}

/** A registered condition test. Pure: it may read state, never write it. */
export type ConditionTest = (
  params: Readonly<Record<string, unknown>>,
  ctx: EvalCtx,
) => boolean;

/** A registered action handler. */
export type ActionHandler = (
  params: Readonly<Record<string, unknown>>,
  ctx: EvalCtx,
) => void;

// ---------------------------------------------------------------------------
// The asset envelope
// ---------------------------------------------------------------------------

/**
 * The common envelope every content asset shares (spec §6).
 *
 * `data` is the type-specific body; everything beside it is what the runtime,
 * the validator and any future editor can rely on without knowing the type. Both
 * this record and `data` are FROZEN by the loader — content definitions are
 * immutable, and anything per-session belongs in `ContentState` or in a runtime
 * instance the engine owns (spec §12.3 draws that line three ways).
 */
export interface ContentAsset<T = unknown> {
  readonly id: ContentId;
  /** Derived from `id`; never authored twice. */
  readonly type: ContentTypeName;
  /** Which schema revision of `type` this body was written against. */
  readonly schema: number;
  /** Which package delivered it. Set by the loader, never authored. */
  readonly pkg: PackageId;
  /** Where it came from, for diagnostics — `bundled:core#3`, `http:…/quests.json`. */
  readonly source: string;
  readonly name?: ContentText;
  readonly description?: ContentText;
  readonly tags: readonly string[];
  /**
   * Availability. Absent means "always". Evaluated against live state, so the
   * same asset answers differently as the story moves.
   */
  readonly when?: Condition;
  /**
   * Every id this asset points at, EXTRACTED rather than authored — the type's
   * `refs()` walks the parsed body, so a reference cannot be forgotten from a
   * hand-maintained list and the reverse-reference graph is complete by
   * construction (spec §4.3, §14.2).
   */
  readonly refs: readonly ContentId[];
  /**
   * Namespaced extension data (spec §6.2). Keys are `<namespace>.<field>`; the
   * editor and the serializer preserve what they do not understand, which is
   * what stops an unknown field being silently deleted on save.
   */
  readonly custom: Readonly<Record<string, unknown>>;
  /** Editor-only annotations. Never read by gameplay. */
  readonly editor?: Readonly<Record<string, unknown>>;
  /** The parsed, frozen, type-specific body. */
  readonly data: T;
}

/** The read side of the registry — what a condition test or the game holds. */
export interface ContentLookup {
  get<T = unknown>(id: ContentId): ContentAsset<T> | undefined;
  /** Every loaded asset of a type, in load order. Never null; may be empty. */
  all<T = unknown>(type: ContentTypeName): readonly ContentAsset<T>[];
  has(id: ContentId): boolean;
}

// ---------------------------------------------------------------------------
// Content types
// ---------------------------------------------------------------------------

/**
 * What a parser is given, and how it complains.
 *
 * A parser REPORTS rather than throws for anything recoverable, so one bad field
 * yields one diagnostic and the rest of the package still loads — spec §21's
 * "fail predictably". Throwing is reserved for a body that cannot produce a
 * usable asset at all.
 */
export interface ParseCtx {
  readonly assetId: ContentId;
  readonly source: string;
  /** Push a diagnostic. `field` is a dotted path inside the asset body. */
  report(d: Omit<Diagnostic, 'assetId' | 'source'> & { field?: string }): void;
}

/**
 * The registration that teaches the runtime about one content type (spec §6.3).
 *
 * This is the extension seam: a new type is a new registration, not a change to
 * the loader, the registry, the validator or the query layer.
 */
export interface ContentTypeDef<T = unknown> {
  readonly name: ContentTypeName;
  /** Current schema revision. An asset authored older goes through `migrate`. */
  readonly schema: number;
  /**
   * Turn an authored body into the runtime record. Returns null when the body is
   * unusable — the loader then skips the asset and keeps the package.
   */
  parse(body: unknown, ctx: ParseCtx): T | null;
  /**
   * Cross-asset checks, run after a whole load when every id is resolvable.
   * Reference existence is checked centrally; this is for the rules only the
   * type knows ("a town's layout must be one the builder registry has").
   */
  validate?(asset: ContentAsset<T>, ctx: ValidateCtx): void;
  /** Every id this body points at. Drives `ContentAsset.refs` and the graph. */
  refs?(data: T): Iterable<ContentId>;
  /** Back to authored JSON, for the editor. Must round-trip `parse`. */
  serialize?(data: T): unknown;
  /** Upgrade a body written against an older `schema` (spec §15.1). */
  migrate?(body: unknown, from: number): unknown;
  /** A valid, obviously-unfinished starting point for a new asset (spec §16.3). */
  readonly template?: unknown;
}

/** What a cross-asset validator may ask. */
export interface ValidateCtx {
  readonly content: ContentLookup;
  report(d: Omit<Diagnostic, 'assetId'> & { assetId?: ContentId }): void;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * How bad a finding is (spec §17.3).
 *
 * The split that matters is `error` vs `fatal`: an error is content the runtime
 * can carry on without (one broken interaction, one unreachable quest), and a
 * fatal is content it cannot (a core package that will not parse). Development
 * continues through errors with placeholders; a build check fails on them.
 */
export type Severity = 'info' | 'warn' | 'error' | 'fatal';

/**
 * One actionable finding (spec §17). Every field beyond `severity`/`code`/
 * `message` exists to answer "which file do I open" without a search.
 */
export interface Diagnostic {
  readonly severity: Severity;
  /** Stable machine code — `missing-ref`, `duplicate-id`, `bad-field`. */
  readonly code: string;
  readonly message: string;
  readonly assetId?: ContentId;
  readonly assetType?: ContentTypeName;
  readonly pkg?: PackageId;
  readonly source?: string;
  /** Dotted path inside the asset body. */
  readonly field?: string;
  /** What to do about it, when that is knowable. */
  readonly fix?: string;
  readonly related?: readonly ContentId[];
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * A package as authored (spec §14). One JSON file describes the package and
 * either carries its assets inline or names sibling files to fetch.
 *
 * Inline is what the core package uses: one file, one request (or none, bundled),
 * and no manifest to keep in step with a directory. `files` exists for packages
 * big enough that loading half of them is worth a second round trip.
 */
export interface RawPackage {
  readonly id: PackageId;
  readonly version?: string;
  /** Packages that must be loaded first. Resolved before this one's assets. */
  readonly requires?: readonly PackageId[];
  /** Loaded if available; a missing one is a warning, not a failure. */
  readonly optional?: readonly PackageId[];
  readonly assets?: readonly unknown[];
  readonly files?: readonly string[];
  readonly meta?: Readonly<Record<string, unknown>>;
}

/**
 * Where content comes from (spec §13). The runtime never knows whether an asset
 * was bundled, fetched or cached — which is what leaves room for a database or a
 * content service later without touching a caller.
 */
export interface StorageProvider {
  /** For diagnostics and for `ContentAsset.source`. */
  readonly name: string;
  /** Higher wins when two providers offer the same package (spec §13.2). */
  readonly priority: number;
  readonly writable: boolean;
  /** Package ids this provider can serve, when it can enumerate them. */
  list(): Promise<readonly PackageId[]>;
  /**
   * Read a package file. `file` omitted means the package's own JSON; otherwise
   * it is one of the manifest's `files`, resolved relative to the package.
   * Returns null when this provider does not have it — absence is not an error,
   * it is how the chain falls through to the next provider.
   */
  read(pkg: PackageId, file?: string): Promise<unknown | null>;
  /** Only when `writable`. Saving elsewhere must fail loudly (spec §13.1). */
  write?(pkg: PackageId, file: string | undefined, value: unknown): Promise<void>;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Who is holding a package open (spec §12.4).
 *
 * Content unloads when nothing needs it, and "needs" is a named holder rather
 * than a count nobody can attribute: a leak shows up as `zone` still holding a
 * quest pack three zones later, which is a readable bug. `boot` is the lease the
 * core package is loaded under and is never released.
 */
export type Lease = 'boot' | 'zone' | 'quest' | 'dialogue' | 'event' | 'editor' | 'debug';

export interface LoadResult {
  readonly pkg: PackageId;
  /** False when the package was already loaded and this only added a lease. */
  readonly loaded: boolean;
  readonly assets: readonly ContentId[];
  readonly diagnostics: readonly Diagnostic[];
}

/** A loaded package as the runtime tracks it. */
export interface PackageInfo {
  readonly id: PackageId;
  readonly version?: string;
  readonly source: string;
  readonly assets: readonly ContentId[];
  readonly requires: readonly PackageId[];
  readonly leases: readonly Lease[];
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * What the player has DONE — the save boundary (spec §8.2, §20).
 *
 * It stores facts, never a copy of the content graph, and it stores them as ids
 * rather than positions. `mainQuestProgress = 7` is the thing this design exists
 * to prevent: inserting a quest into an existing line must not move an existing
 * player backward, and it cannot when availability is recomputed from completed
 * ids and flags (spec §9.3).
 */
export interface ContentState {
  /** A world flag: set, cleared, and tested by conditions. */
  flag(name: string): boolean;
  setFlag(name: string, on: boolean): void;
  /** Every set flag, for the save and for diagnostics. */
  readonly flags: readonly string[];

  questStatus(id: ContentId): QuestStatus;
  setQuestStatus(id: ContentId, status: QuestStatus): void;
  readonly activeQuests: readonly ContentId[];
  readonly completedQuests: readonly ContentId[];

  /** Objective progress within an active quest, by objective key. */
  progress(quest: ContentId, objective: string): number;
  setProgress(quest: ContentId, objective: string, n: number): void;

  /** Points of interest the player has found. */
  discovered(id: ContentId): boolean;
  discover(id: ContentId): void;

  /** Fires after any mutation, so conditions can be re-evaluated once. */
  onChange(fn: (what: StateChange) => void): () => void;

  /** The save payload. Plain JSON — no class instances, no undefined. */
  toJSON(): unknown;
  /** Replace everything from a save. Unknown fields are preserved. */
  fromJSON(value: unknown): void;
  /** Back to a fresh profile — what Exit to title does. */
  reset(): void;
}

export type QuestStatus = 'unknown' | 'available' | 'active' | 'completed' | 'failed';

export interface StateChange {
  readonly kind: 'flag' | 'quest' | 'progress' | 'discovery' | 'reset';
  readonly name: string;
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * The graph questions tools, agents and gameplay ask (spec §18.2, §19).
 *
 * Reverse lookup is the half that cannot be done by walking files: "what breaks
 * if I delete this" is the question an editor must answer before it offers a
 * delete button, and only an index can answer it.
 */
export interface ContentQuery {
  /** Ids this asset points at. */
  refs(id: ContentId): readonly ContentId[];
  /** Ids that point AT this asset. */
  referrers(id: ContentId): readonly ContentId[];
  /** Everything reachable from a root, ids only, cycle-safe. */
  reachable(root: ContentId): readonly ContentId[];
  /** Assets carrying every one of these tags. */
  byTag(...tags: readonly string[]): readonly ContentAsset[];
  /** Substring match over id, tags and resolved display name. */
  search(text: string, type?: ContentTypeName): readonly ContentAsset[];
  /** Loaded assets of a type whose `when` passes against current state. */
  available<T = unknown>(type: ContentTypeName): readonly ContentAsset<T>[];
  /** Ids referenced by loaded content that no loaded asset defines. */
  dangling(): readonly ContentId[];
  /** Loaded assets nothing points at and no system enumerates by type. */
  orphans(): readonly ContentId[];
}

// ---------------------------------------------------------------------------
// The runtime facade
// ---------------------------------------------------------------------------

/**
 * The one object the game holds. Everything above is reachable from it, and
 * nothing outside `src/content/` constructs the pieces individually.
 */
export interface ContentRuntime extends ContentLookup {
  readonly state: ContentState;
  readonly query: ContentQuery;

  /** Register a content type. Before any load that uses it. */
  defineType<T>(def: ContentTypeDef<T>): void;
  /** Register a condition test / action handler (spec §4.6's controlled seam). */
  defineTest(name: string, fn: ConditionTest): void;
  defineAction(name: string, fn: ActionHandler): void;
  /**
   * Register a named engine behaviour a piece of content may SELECT — a voxel
   * builder, a town layout, an animator. Keyed `<kind>/<name>`, e.g.
   * `npc-body/gain`. This is what keeps executable code out of JSON.
   */
  defineFactory(kind: string, name: string, value: unknown): void;
  factory<V = unknown>(kind: string, name: string): V | undefined;

  /** Add a storage provider. Highest `priority` answers first. */
  addProvider(p: StorageProvider): void;

  /** Load a package and its dependencies under a lease. Idempotent. */
  load(pkg: PackageId, lease?: Lease): Promise<LoadResult>;
  /** Drop a lease; the package unloads when its last one goes (spec §12.3). */
  release(pkg: PackageId, lease?: Lease): void;
  /** Fires after a load or unload changes the set of available definitions. */
  onDefinitionsChange(fn: () => void): () => void;
  readonly packages: readonly PackageInfo[];

  /** Availability, against live state. A missing/unknown test is false. */
  evaluate(when: Condition | undefined): boolean;
  /** Run an action list in order. Unknown actions are reported and skipped. */
  run(actions: readonly Action[] | undefined): void;

  /** Everything found so far, worst first. */
  diagnostics(): readonly Diagnostic[];
}
