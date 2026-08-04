/**
 * THE COMPOSITION ROOT FOR CONTENT — the one place the registry, the graph, the
 * loader, the provider chain, the state store, the evaluator, the dispatcher and
 * the query layer are wired into one another, and the one place the six content
 * types and the shipped tests, actions and providers are registered.
 *
 * It is to `src/content/` exactly what `src/main.ts` is to the game: every module
 * under here depends on `./types` and never on a sibling's implementation, so
 * nothing else knows how the pieces fit together. `ContentRuntime` (types.ts) is
 * the object the game holds; nothing outside this directory constructs the
 * pieces individually.
 *
 * NOTHING IN `src/content/` IMPORTS `./storage/bundled` STATICALLY — NOT EVEN
 * THIS FILE — AND THE REASON IS A TOOL RATHER THAN A PREFERENCE.
 * `storage/bundled.ts` uses Vite's `import.meta.glob`, which does not exist
 * under plain Bun, and `tools/test-zfight.mjs` imports game modules STRAIGHT
 * INTO BUN with no Vite at all, to build every rig in the game and look for
 * coincident surfaces. `world/npc.ts` is one of the modules it imports and
 * `world/npc.ts` reads content, so a static edge from here to the glob would
 * have stopped that probe running the day the world started reading content.
 *
 * So the edge is DYNAMIC and it is inside `bootstrapContent()`:
 * `await import('./storage/bundled')`. A dynamic import is a call rather than a
 * module-graph edge, so a tool that never boots content never evaluates the
 * module that holds the glob.
 *
 * AND THE TWO VITE ENTRY POINTS STILL IMPORT IT STATICALLY, WHICH IS NOT A
 * CONTRADICTION — IT IS THE OTHER HALF. A dynamic import is a CHUNK BOUNDARY to
 * the bundler, and a chunk boundary on this path is a REQUEST ON THE BOOT PATH:
 * built with `bootstrapContent()` as the only route to the provider, the output
 * carried a lazy `assets/bundled-*.js` (5.42 kB) plus Vite's preload helper, and
 * `bootstrapContent` measured **15.6 / 16.1 / 15.8 ms** on the dev server
 * against **2.4 / 2.5 / 2.3 ms** with the provider imported by the entry. All of
 * that difference is a round trip for a module that could have been linked. It
 * is also a request that can fail, for the one package `storage/bundled.ts`'s
 * own header says must never be one. So `src/main.ts` and `src/lab/index.ts`
 * `import { BundledProvider }` and hand it to `addProvider` themselves; the
 * dynamic form above is left as the FALLBACK for a runtime nobody gave a
 * provider to. Both entry points only ever run under Vite, so neither can take
 * the glob anywhere Bun would have to evaluate it.
 *
 * (`core.json` itself lands in a statically preloaded chunk either way — Rollup
 * puts the JSON module in the chunk the two entries share. What moved is the
 * PROVIDER, and with it whether reading the core package waits on a fetch.)
 *
 * WHAT THAT MEANS IN PRACTICE, for the wiring around it:
 *
 *   - ANY GAME MODULE MAY `import { content } from '../content'`. That is the
 *     whole point of the arrangement: `world/towns.ts`, `world/npc.ts` and
 *     `combat/enemies.ts` read the singleton directly, exactly as they already
 *     read `world/nature.ts`'s and `core/gfx.ts`'s, rather than having a runtime
 *     threaded through every constructor between `main.ts` and them.
 *   - a module that only needs the registry, the graph, the query layer, a
 *     content TYPE or `resolveText` may still import that module directly
 *     (`./content/registry`, `./content/types/town`, `./content/text`); every one
 *     of those is storage-free and runs under Bun.
 *   - `src/main.ts` — the game's own composition root — is the one module that
 *     calls `bootstrapContent()`, and therefore the one place the Vite-only half
 *     is ever reached. `src/lab/index.ts` calls it too, for the same reason and
 *     under the same bundler.
 *
 * FACTORIES ARE THE SEAM THE ENGINE FILLS IN. Content selects a behaviour by
 * name and never supplies one (types.ts §4.6), so every voxel builder and town
 * layout stays in TypeScript and only its CHOICE is data. Four kinds are named
 * by the shipped content, and the registrations the game owes them are:
 *
 *     town-layout/camp        the walled Encampment          world/towns.ts
 *     town-layout/hamlet      the open settlement            world/towns.ts
 *     npc-body/gain           build() + animate()            world/npc-gain.ts
 *     enemy-model/gloopling   the voxel builder              combat/enemies.ts
 *     enemy-model/snortle     "
 *     enemy-model/peckit      "
 *     music-track/title       the bundled .webm's URL        audio/music.ts
 *     music-track/overworld   "
 *
 * Registering one also PUBLISHES its name to the content type that validates
 * against it, so `"layout": "capm"` is an `unknown-factory` finding on the field
 * that holds it rather than a builder lookup that returns undefined somewhere in
 * the middle of world creation. Register before `bootstrapContent()`; a kind
 * nobody has registered anything for is not checked at all, which is what keeps
 * a headless validation run from reporting every town (see `setKnownTownLayouts`
 * in types/town.ts).
 */

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
export { ENEMY_TYPE, ENEMY_MODEL_KIND } from './types/enemy';
export { MUSIC_TYPE, MUSIC_TRACK_KIND } from './types/music';
export { NPC_TYPE, NPC_BODY_KIND } from './types/npc';
export { QUEST_TYPE } from './types/quest';
export { TOWN_TYPE, TOWN_LAYOUT_KIND, CARRIED_LAYOUT_KIND } from './types/town';
export type { BiomeData } from './types/biome';
export type { EnemyData, EnemyVariant } from './types/enemy';
export type { MusicData } from './types/music';
export type { NpcData, NpcTalkLine } from './types/npc';
export type { QuestData, QuestObjective, QuestRewards } from './types/quest';
export type { TownData } from './types/town';

/**
 * Types whose display name is required.
 *
 * Five of the six, because those five are shown to a player — a town's compass
 * chip, an NPC's talk prompt, a biome in a debug readout, an enemy in whatever
 * renders one first, a quest in a journal. A nameless one is issue #17's failure
 * from the other end: a blank label reads as a broken HUD rather than as missing
 * content, and a screenshot cannot tell the two apart.
 *
 * `music` IS THE ONE THAT IS NOT, and deliberately: a playlist is never printed
 * anywhere. Requiring a name for it would make every area's music an entry in
 * `src/i18n/en.ts` that no screen ever reads, which is a translation burden
 * bought with nothing.
 */
const NAMED_TYPES: readonly ContentTypeName[] = ['town', 'npc', 'biome', 'enemy', 'quest'];

/**
 * The types the engine finds by ENUMERATION rather than by reference, so
 * `orphans()` does not report every root in the game.
 *
 * query.ts's default covers town, biome, enemy and quest; `npc` is added here
 * because the world places every character it is given, exactly as it places
 * every town — `Npcs`'s constructor in world/npc.ts walks `content.all('npc')`,
 * and that walk is the enumeration. Nothing in core points AT `npc:gain` (he
 * names his town, not the other way round), so without this the one NPC in the
 * game reports as unreachable content. query.ts's own comment says a runtime
 * with its own set of roots passes it; this is that.
 *
 * `music` is a root for the same reason and by a stronger form of it: a playlist
 * is found by the id the AREA already has (`music:overworld`), so nothing points
 * at one by construction and nothing ever will.
 */
const ROOT_TYPES: ReadonlySet<ContentTypeName> = new Set([...ENUMERATED_TYPES, 'npc', 'music']);

/** Kind -> the content type that validates a selection of it. See the header. */
const FACTORY_PUBLISHERS: Readonly<Record<string, (names: Iterable<string>) => void>> = {
  [TOWN_LAYOUT_KIND]: setKnownTownLayouts,
  [CARRIED_LAYOUT_KIND]: setKnownCarriedLayouts,
  [NPC_BODY_KIND]: setKnownNpcBodies,
  [ENEMY_MODEL_KIND]: setKnownEnemyModels,
  [MUSIC_TRACK_KIND]: setKnownMusicTracks,
};

export interface ContentRuntimeOptions {
  /**
   * Storage providers, highest priority first-served.
   *
   * DEFAULTS TO NONE, and that is the price of the dynamic-import rule in the
   * header: a default of `[new BundledProvider()]` is a static edge to the glob,
   * which is exactly what may not exist here. `bootstrapContent()` adds the
   * bundled provider to a runtime that has none, so the game's own boot is
   * unchanged — what moved is WHERE the provider is constructed, not whether it
   * is. A caller making a second runtime with `createContentRuntime()` and
   * wanting the bundled packages passes one in, or calls `addProvider` after;
   * a caller adding an `HttpProvider` did that already.
   */
  readonly providers?: readonly StorageProvider[];
  /** Register the five shipped content types. Default true. */
  readonly types?: boolean;
  /** Register the shipped condition tests and action handlers. Default true. */
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
  /** Findings this object made itself — a registry refusal the loader cannot see. */
  private readonly own: Diagnostic[] = [];
  /** The last `validateContent` run, so `diagnostics()` includes it. */
  private validation: readonly Diagnostic[] = [];

  readonly state = new ContentStateStore();
  readonly query: Query;

  /**
   * Built ONCE and handed to every test and every handler.
   *
   * `evaluate` is called from UI paths and may run per frame for every loaded
   * asset of a type (conditions.ts says so, and query.ts's `available` is the
   * caller), so a fresh `{ state, content }` per call would be an allocation per
   * asset per frame. Both fields are stable for the life of the runtime.
   */
  private readonly ctx: EvalCtx;

  constructor(opts: ContentRuntimeOptions = {}) {
    for (const provider of opts.providers ?? []) this.chain.add(provider);

    this.loader = new PackageLoader({
      chain: this.chain,
      types: { type: (name) => this.typeDefs.get(name) },
      registry: {
        // The loader checks `has` before it builds an asset, so a refusal here
        // is a registry-level identity problem rather than a duplicate — it is
        // kept rather than thrown, for the reason everything in this system
        // reports rather than throws (diagnostics.ts).
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
      // query.ts documents its resolver as answering '' for absent text, and
      // `search` tests for exactly that — where `resolveText` never returns a
      // blank on purpose (text.ts). So the two meet here rather than either
      // bending: no text is no match.
      (text) => (hasText(text) ? resolveText(text) : ''),
      ROOT_TYPES,
    );

    // One call each rather than a loop over an array: `defineType<T>` binds T
    // per call, and a mixed array collapses to a union that satisfies no single
    // instantiation of it. Six lines is also the honest shape — this is the
    // list of content types the game has.
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

  // -------------------------------------------------------------------------
  // ContentLookup — the read side, hot
  // -------------------------------------------------------------------------

  get<T = unknown>(id: ContentId): ContentAsset<T> | undefined {
    return this.registry.get<T>(id);
  }

  all<T = unknown>(type: ContentTypeName): readonly ContentAsset<T>[] {
    return this.registry.all<T>(type);
  }

  has(id: ContentId): boolean {
    return this.registry.has(id);
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  defineType<T>(def: ContentTypeDef<T>): void {
    // The cast is the same one every implementation of a generic registry makes
    // and is the one `ContentLookup.get<T>` builds in: the parser that produced
    // a body is the only thing that ever knew its type, and no store can check
    // a caller's claim about it. It is not a narrowing of untrusted JSON.
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
    // Same shape of claim as `defineType`: the caller names the type it stored.
    return held === undefined ? undefined : (held as V);
  }

  addProvider(p: StorageProvider): void {
    this.chain.add(p);
  }

  /** Whether anything can answer a `read` at all. See `bootstrapContent`. */
  get hasProviders(): boolean {
    return this.chain.providers.length > 0;
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  load(pkg: PackageId, lease: Lease = 'boot'): Promise<LoadResult> {
    return this.loader.load(pkg, lease);
  }

  release(pkg: PackageId, lease: Lease = 'boot'): void {
    this.loader.release(pkg, lease);
  }

  get packages(): readonly PackageInfo[] {
    return this.loader.packages;
  }

  // -------------------------------------------------------------------------
  // Availability
  // -------------------------------------------------------------------------

  evaluate(when: Condition | undefined): boolean {
    return this.evaluator.evaluate(when, this.ctx);
  }

  run(actions: readonly Action[] | undefined): void {
    this.dispatcher.run(actions, this.ctx);
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  /**
   * Everything found so far, worst first, from all five sources that can find
   * something. Through a `DiagnosticSink` rather than concatenated, so the
   * dedupe on (code, assetId, field) applies ACROSS them — the load pass and the
   * cross-asset pass both find a broken reference and write different sentences
   * about it (diagnostics.ts).
   */
  diagnostics(): readonly Diagnostic[] {
    const sink = new DiagnosticSink();
    sink.addAll(this.loader.diagnostics);
    sink.addAll(this.own);
    sink.addAll(this.validation);
    sink.addAll(this.evaluator.diagnostics());
    sink.addAll(this.dispatcher.diagnostics());
    return sink.sorted();
  }

  /** The `Loaded` view `validateContent` takes. */
  loadedView(): Loaded {
    return {
      all: (type) => this.registry.all(type),
      get: (id) => this.registry.get(id),
      // Every REGISTERED type, not only the ones with assets: a type whose whole
      // package failed to load must still be a type the validator knows about,
      // or a reference to it reads as `unknown-type` on top of the real problem.
      types: () => [...new Set([...this.registry.types(), ...this.typeDefs.keys()])].sort(),
      typeDef: (type) => this.typeDefs.get(type),
    };
  }

  /** Run the cross-asset pass and remember it for `diagnostics()`. */
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

/** Assemble a content runtime. Every dependency is wired here and nowhere else. */
export function createContentRuntime(opts: ContentRuntimeOptions = {}): ContentRuntime {
  return new Runtime(opts);
}

/**
 * THE RUNTIME THE GAME HOLDS.
 *
 * A module-level singleton for the same reason `src/world/nature.ts` and
 * `src/core/gfx.ts` have one: there is exactly one of these per page, the
 * alternative is threading it through every constructor in the game before the
 * first caller needs it, and `Exit to title` resets the STATE (which is what a
 * session is) rather than rebuilding the graph — the definitions are pure
 * functions of the build, exactly as the world is a pure function of the seed.
 *
 * `createContentRuntime()` remains the way to make a second one, and a probe or
 * an editor that wants an isolated graph should.
 *
 * Held internally as the concrete class so `bootstrapContent` can reach the two
 * methods the `ContentRuntime` contract does not carry — the `Loaded` view and
 * the cross-asset pass — and exported as the CONTRACT, so nothing outside this
 * file can grow a dependency on the implementation.
 */
const singleton = new Runtime();
export const content: ContentRuntime = singleton;

/** Bound to the singleton, so the engine's builders read as one line each. */
export function defineFactory(kind: string, name: string, value: unknown): void {
  content.defineFactory(kind, name, value);
}

/** Bound to the singleton. `undefined` when nothing registered that name. */
export function factory<V = unknown>(kind: string, name: string): V | undefined {
  return content.factory<V>(kind, name);
}

export interface BootstrapOptions {
  /**
   * What an error costs (validate.ts). `dev` by default and deliberately: a
   * developer mid-edit always has half-written content, and a boot that refused
   * it is a boot that gets bypassed within a week. A build check runs `check`.
   */
  readonly level?: ValidationLevel;
  /**
   * Flags engine code sets, which no content anywhere writes. Without them every
   * engine-owned flag reads as a quest that can never start — the reachability
   * check cannot see a `setFlag` in main.ts.
   */
  readonly engineFlags?: readonly string[];
}

export interface ContentBootResult {
  /** False when the package was already loaded and this only added a lease. */
  readonly loaded: boolean;
  readonly assets: readonly ContentId[];
  /** Everything the load and the cross-asset pass found, worst first. */
  readonly diagnostics: readonly Diagnostic[];
  /** True when nothing `error` or worse was found. */
  readonly ok: boolean;
}

/**
 * Load the core package into the singleton and check it.
 *
 * IT BOOTS `content` AND NOTHING ELSE, deliberately: a second runtime is a
 * deliberate act (a probe, an editor, an isolated graph), and whoever made one
 * knows which package they want in it — `createContentRuntime()` then
 * `runtime.load(...)` is two lines. A boot function that could be pointed
 * anywhere would make "did the game's content load" a question with more than
 * one answer.
 *
 * UNDER THE `boot` LEASE, WHICH IS NEVER RELEASED (types.ts): core content is
 * the starting world, and there is no state of the game in which it should be
 * collected. Every other package is held by a named holder that eventually lets
 * go — a zone, a quest, a dialogue — which is what makes a leak readable as
 * "`zone` still holds this three zones later" rather than as a count nobody can
 * attribute.
 *
 * IT DOES NOT THROW, and the caller decides. `assertLoadable` is re-exported
 * from this module for a boot path that wants to stop on a fatal; a probe, a
 * tool and the F2 side of the world all want the findings instead. Everything
 * short of fatal degrades with a placeholder by construction — that is what the
 * whole diagnostics design is for.
 *
 * A RUNTIME WITH NO PROVIDER GETS THE BUNDLED ONE, dynamically — the fallback
 * described in the header, so that `bootstrapContent()` on its own is enough and
 * the Vite-only `import.meta.glob` is still never evaluated by a tool that
 * imports a game module under plain Bun. The two entry points add the provider
 * before calling this, which is what keeps `core.json` in the main chunk; this
 * branch is what makes the function honest without them.
 */
export async function bootstrapContent(opts: BootstrapOptions = {}): Promise<ContentBootResult> {
  if (!singleton.hasProviders) {
    const { BundledProvider } = await import('./storage/bundled');
    singleton.addProvider(new BundledProvider());
  }
  const result = await singleton.load('core', 'boot');
  singleton.validate(opts.level ?? 'dev', opts.engineFlags ?? []);
  // The merged, deduped, worst-first view: the load findings and the validation
  // just run are both already in it (see `diagnostics()`).
  const merged = singleton.diagnostics();
  return {
    loaded: result.loaded,
    assets: result.assets,
    diagnostics: merged,
    ok: !merged.some((d) => d.severity === 'error' || d.severity === 'fatal'),
  };
}
