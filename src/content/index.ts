// The composition root for content: the one place the pieces are wired and the six
// types, shipped tests, actions and providers are registered.
//
// NOTHING IN `src/content/` MAY IMPORT `./storage/bundled` STATICALLY. It uses Vite's
// `import.meta.glob`, and `tools/test-zfight.mjs` imports game modules straight into
// Bun with no Vite. So the edge here is dynamic, inside `bootstrapContent` — a call
// rather than a module-graph edge. The two Vite ENTRY POINTS do import it statically
// and hand it to `addProvider`, because a dynamic import is a chunk boundary and that
// is a request on the boot path (15.6 ms vs 2.4 ms measured).
//
// Registering a factory PUBLISHES its name to the type that validates against it, so a
// typo is an `unknown-factory` finding. Register BEFORE `bootstrapContent()`; a kind
// with nothing registered is not checked at all.

import { ActionDispatcher, registerCoreActions } from './actions';
import { ConditionEvaluator, registerCoreTests } from './conditions';
import { DiagnosticSink } from './diagnostics';
import { PackageLoader } from './loader';
import { ENUMERATED_TYPES, Query } from './query';
import { ContentRegistry } from './registry';
import { ContentStateStore } from './state';
import { hasText, isKnownTextKey, resolveText } from './text';
import { validateContent } from './validate';
import type { Loaded, ValidationLevel } from './validate';
import { ProviderChain } from './storage/chain';
import { BIOME_TYPE } from './types/biome';
import { ENEMY_MODEL_KIND, ENEMY_TYPE, setKnownEnemyModels } from './types/enemy';
import { MUSIC_TRACK_KIND, MUSIC_TYPE, setKnownMusicTracks } from './types/music';
import { NPC_BODY_KIND, NPC_TYPE, setKnownNpcBodies } from './types/npc';
import { QUEST_TYPE } from './types/quest';
import {
  CARRIED_LAYOUT_KIND, TOWN_LAYOUT_KIND, TOWN_TYPE,
  setKnownCarriedLayouts, setKnownTownLayouts,
} from './types/town';
import type {
  Action,
  Condition,
  ConditionTest,
  ContentAsset,
  ContentId,
  ContentRuntime,
  ContentTypeDef,
  ContentTypeName,
  Diagnostic,
  EvalCtx,
  Lease,
  LoadResult,
  PackageId,
  PackageInfo,
  StorageProvider,
} from './types';
import type { ActionHandler } from './types';

export { assertLoadable, failsCheck, validateContent } from './validate';
export type { ValidationLevel } from './validate';
export { hasText, isKnownTextKey, resolveText, textKeyOf } from './text';
export { BIOME_TYPE } from './types/biome';
export { ENEMY_TYPE, ENEMY_MODEL_KIND, BEAST_MODEL_PREFIX } from './types/enemy';
export { MUSIC_TYPE, MUSIC_TRACK_KIND } from './types/music';
export { NPC_TYPE, NPC_BODY_KIND } from './types/npc';
export { QUEST_TYPE } from './types/quest';
export { TOWN_TYPE, TOWN_LAYOUT_KIND, CARRIED_LAYOUT_KIND } from './types/town';
export type { BiomeData } from './types/biome';
export type { EnemyCapture, EnemyData, EnemyVariant } from './types/enemy';
export type { MusicData } from './types/music';
export type { NpcData, NpcTalkLine } from './types/npc';
export type {
  ObjectiveTrigger, ObjectiveTriggerKind, QuestData, QuestObjective, QuestRewards,
} from './types/quest';
export type { TownData } from './types/town';

// The five types a player sees; a blank label reads as a broken HUD (issue #17).
// `music` is excluded: a playlist is never printed, so a name would be dead translation.
const NAMED_TYPES: readonly ContentTypeName[] = ['town', 'npc', 'biome', 'enemy', 'quest'];

// query.ts's defaults plus `npc` (world/npc.ts walks `all('npc')` — nothing points AT
// an NPC) and `music` (an area looks a playlist up by id). Otherwise both report orphaned.
const ROOT_TYPES: ReadonlySet<ContentTypeName> = new Set([...ENUMERATED_TYPES, 'npc', 'music']);

/** Kind -> the content type that validates a selection of it. */
const FACTORY_PUBLISHERS: Readonly<Record<string, (names: Iterable<string>) => void>> = {
  [TOWN_LAYOUT_KIND]: setKnownTownLayouts,
  [CARRIED_LAYOUT_KIND]: setKnownCarriedLayouts,
  [NPC_BODY_KIND]: setKnownNpcBodies,
  [ENEMY_MODEL_KIND]: setKnownEnemyModels,
  [MUSIC_TRACK_KIND]: setKnownMusicTracks,
};

export interface ContentRuntimeOptions {
  // Defaults to NONE: a `[new BundledProvider()]` default would be the static edge to
  // the glob this file may not have. `bootstrapContent()` fills one in.
  readonly providers?: readonly StorageProvider[];
  readonly types?: boolean;
  readonly core?: boolean;
}

class Runtime implements ContentRuntime {
  private readonly registry = new ContentRegistry();
  private readonly typeDefs = new Map<ContentTypeName, ContentTypeDef>();
  private readonly evaluator = new ConditionEvaluator();
  private readonly dispatcher = new ActionDispatcher();
  private readonly chain = new ProviderChain();
  private readonly loader: PackageLoader;
  private readonly factories = new Map<string, unknown>();
  private readonly definitionListeners: Array<() => void> = [];
  /** Registry refusals the loader cannot see. */
  private readonly own: Diagnostic[] = [];
  private validation: readonly Diagnostic[] = [];

  readonly state = new ContentStateStore();
  readonly query: Query;

  /** Built ONCE: `evaluate` runs per frame, so a fresh ctx would allocate per asset. */
  private readonly ctx: EvalCtx;

  constructor(opts: ContentRuntimeOptions = {}) {
    for (const provider of opts.providers ?? []) this.chain.add(provider);

    this.loader = new PackageLoader({
      chain: this.chain,
      types: { type: (name) => this.typeDefs.get(name) },
      registry: {
        // The loader checked `has` already, so a refusal here is an identity problem,
        // not a duplicate — kept as a finding rather than thrown.
        add: (asset) => {
          const bad = this.registry.add(asset);
          if (bad) this.own.push(bad);
        },
        remove: (id) => {
          this.registry.remove(id);
        },
        has: (id) => this.registry.has(id),
      },
    });

    this.ctx = { state: this.state, content: this.registry };
    this.query = new Query(
      this.registry,
      this.registry.graph,
      (when) => this.evaluate(when),
      // query.ts wants '' for absent text; `resolveText` never blanks. No text, no match.
      (text) => (hasText(text) ? resolveText(text) : ''),
      ROOT_TYPES,
    );

    // One call each, not a loop: `defineType<T>` binds T per call, and a mixed array
    // collapses to a union no single instantiation satisfies.
    if (opts.types !== false) {
      this.defineType(TOWN_TYPE);
      this.defineType(NPC_TYPE);
      this.defineType(BIOME_TYPE);
      this.defineType(ENEMY_TYPE);
      this.defineType(QUEST_TYPE);
      this.defineType(MUSIC_TYPE);
    }
    if (opts.core !== false) {
      registerCoreTests(this.evaluator);
      registerCoreActions(this.dispatcher);
    }
  }

  get<T = unknown>(id: ContentId): ContentAsset<T> | undefined {
    return this.registry.get<T>(id);
  }

  all<T = unknown>(type: ContentTypeName): readonly ContentAsset<T>[] {
    return this.registry.all<T>(type);
  }

  has(id: ContentId): boolean {
    return this.registry.has(id);
  }

  defineType<T>(def: ContentTypeDef<T>): void {
    // The cast `ContentLookup.get<T>` builds in: no store can check a caller's claim
    // about a body's type. Not a narrowing of untrusted JSON.
    this.typeDefs.set(def.name, def as ContentTypeDef);
  }

  defineTest(name: string, fn: ConditionTest): void {
    this.evaluator.define(name, fn);
  }

  defineAction(name: string, fn: ActionHandler): void {
    this.dispatcher.define(name, fn);
  }

  defineFactory(kind: string, name: string, value: unknown): void {
    this.factories.set(`${kind}/${name}`, value);
    const publish = FACTORY_PUBLISHERS[kind];
    if (publish === undefined) return;
    const prefix = `${kind}/`;
    const names: string[] = [];
    for (const key of this.factories.keys()) {
      if (key.startsWith(prefix)) names.push(key.slice(prefix.length));
    }
    publish(names);
  }

  factory<V = unknown>(kind: string, name: string): V | undefined {
    const held = this.factories.get(`${kind}/${name}`);
    return held === undefined ? undefined : (held as V);
  }

  addProvider(p: StorageProvider): void {
    this.chain.add(p);
  }

  /** Whether anything can answer a `read` at all. See `bootstrapContent`. */
  get hasProviders(): boolean {
    return this.chain.providers.length > 0;
  }

  async load(pkg: PackageId, lease: Lease = 'boot'): Promise<LoadResult> {
    const result = await this.loader.load(pkg, lease);
    if (result.loaded) this.notifyDefinitionsChanged();
    return result;
  }

  release(pkg: PackageId, lease: Lease = 'boot'): void {
    const before = this.loader.packages.length;
    this.loader.release(pkg, lease);
    if (this.loader.packages.length !== before) this.notifyDefinitionsChanged();
  }

  onDefinitionsChange(fn: () => void): () => void {
    this.definitionListeners.push(fn);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      const i = this.definitionListeners.indexOf(fn);
      if (i >= 0) this.definitionListeners.splice(i, 1);
    };
  }

  private notifyDefinitionsChanged(): void {
    for (const fn of this.definitionListeners.slice()) fn();
  }

  get packages(): readonly PackageInfo[] {
    return this.loader.packages;
  }

  evaluate(when: Condition | undefined): boolean {
    return this.evaluator.evaluate(when, this.ctx);
  }

  run(actions: readonly Action[] | undefined): void {
    this.dispatcher.run(actions, this.ctx);
  }

  // Through a sink rather than concatenated, so the dedupe applies ACROSS the five
  // sources — two passes word the same broken reference differently.
  diagnostics(): readonly Diagnostic[] {
    const sink = new DiagnosticSink();
    sink.addAll(this.loader.diagnostics);
    sink.addAll(this.own);
    sink.addAll(this.validation);
    sink.addAll(this.evaluator.diagnostics());
    sink.addAll(this.dispatcher.diagnostics());
    return sink.sorted();
  }

  loadedView(): Loaded {
    return {
      all: (type) => this.registry.all(type),
      get: (id) => this.registry.get(id),
      // Every REGISTERED type, not only those with assets, or a reference into a
      // package that failed to load reads as `unknown-type` on top of the real problem.
      types: () => [...new Set([...this.registry.types(), ...this.typeDefs.keys()])].sort(),
      typeDef: (type) => this.typeDefs.get(type),
    };
  }

  validate(level: ValidationLevel, engineFlags: readonly string[]): readonly Diagnostic[] {
    this.validation = validateContent(this.loadedView(), {
      level,
      engineFlags,
      requireName: NAMED_TYPES,
      tests: this.evaluator.testNames,
      actions: this.dispatcher.actionNames,
      orphans: () => this.query.orphans(),
      knownTextKey: isKnownTextKey,
    });
    return this.validation;
  }
}

export function createContentRuntime(opts: ContentRuntimeOptions = {}): ContentRuntime {
  return new Runtime(opts);
}

// The runtime the game holds. One per page; `Exit to title` resets the STATE and never
// the graph, since definitions are a pure function of the build.
// Held as the concrete class so `bootstrapContent` can reach `loadedView`/`validate`,
// exported as the CONTRACT so nothing outside depends on the implementation.
const singleton = new Runtime();
export const content: ContentRuntime = singleton;

export function defineFactory(kind: string, name: string, value: unknown): void {
  content.defineFactory(kind, name, value);
}

/** `undefined` when nothing registered that name. */
export function factory<V = unknown>(kind: string, name: string): V | undefined {
  return content.factory<V>(kind, name);
}

export interface BootstrapOptions {
  /** `dev` by default: a boot that refuses half-written content gets bypassed. */
  readonly level?: ValidationLevel;
  /** Flags engine code sets; without them they read as quests that never start. */
  readonly engineFlags?: readonly string[];
  // Loaded after `core` and BEFORE the cross-asset pass — that is the whole point of
  // the option, since validation runs once, inside. Under the `boot` lease, like core;
  // a package that arrives at a zone edge belongs to the zone instead.
  readonly packages?: readonly PackageId[];
}

export interface ContentBootResult {
  /** False when the package was already loaded and this only added a lease. */
  readonly loaded: boolean;
  readonly assets: readonly ContentId[];
  /** Load and cross-asset pass together, worst first. */
  readonly diagnostics: readonly Diagnostic[];
  /** Nothing `error` or worse was found. */
  readonly ok: boolean;
}

// Boots `content` and nothing else, so "did the game's content load" has one answer.
// Under the `boot` lease, which is never released; every other package has a named
// holder that lets go, so a leak reads as "zone still holds this".
// Does not throw — the caller decides, with `assertLoadable` if it wants to stop.
// A runtime with no provider gets the bundled one DYNAMICALLY, so the Vite-only glob is
// never evaluated under plain Bun.
export async function bootstrapContent(opts: BootstrapOptions = {}): Promise<ContentBootResult> {
  if (!singleton.hasProviders) {
    const { BundledProvider } = await import('./storage/bundled');
    singleton.addProvider(new BundledProvider());
  }
  const result = await singleton.load('core', 'boot');
  // Sequential for readability: overlapping loads of one id share a promise anyway.
  const extra: ContentId[] = [];
  for (const pkg of opts.packages ?? []) {
    extra.push(...(await singleton.load(pkg, 'boot')).assets);
  }
  singleton.validate(opts.level ?? 'dev', opts.engineFlags ?? []);
  const merged = singleton.diagnostics();
  return {
    loaded: result.loaded,
    assets: [...result.assets, ...extra],
    diagnostics: merged,
    ok: !merged.some((d) => d.severity === 'error' || d.severity === 'fatal'),
  };
}
