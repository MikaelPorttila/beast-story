/**
 * The cross-asset pass: everything that can only be known once a whole load is
 * on the table (spec §17).
 *
 * A PARSER SEES ONE BODY; THIS SEES THE GRAPH. That is the entire division of
 * labour with schema.ts. "Is `radius` a number" is answerable while reading the
 * town, and is answered there. "Does `enemy:gloopling` exist" is not answerable
 * until the package that defines gloopling has loaded — possibly a package that
 * loads at a zone edge twenty minutes later — so it is answered here, after, by
 * the loader and again by the guard tool.
 *
 * THIS FILE THROWS IN EXACTLY ONE FUNCTION, and only on `fatal`. Everything else
 * degrades with a placeholder, and the reason is a player rather than a
 * developer: a session is the only thing in this system that cannot be
 * recreated. A quest file that will not parse must cost that quest, not the
 * afternoon. `assertLoadable` is the one place where content is bad enough that
 * there is nothing left to run — a core package that will not parse leaves no
 * world to stand in — and it is called by the boot path and by the packaging
 * tool, never per asset.
 *
 * THE ENVIRONMENT DECIDES WHAT AN ERROR COSTS, NOT THE FINDING (spec §17.3), so
 * `level` escalates rather than filters — a `ship` run makes every error fatal
 * and the same code means the same thing everywhere:
 *
 *   dev   — as found. The game boots, broken assets carry placeholders, the F2
 *           side of the world keeps working. A designer mid-edit ALWAYS has
 *           half-written content, and a system that refuses to boot on it is a
 *           system that gets bypassed within a week.
 *   check — as found, and the tool exits non-zero on anything `error` or worse
 *           (`failsCheck`). Same picture as the developer sees, different
 *           consequence.
 *   ship  — every `error` becomes `fatal`, so packaging refuses to emit a build
 *           with a dangling reference in it. Warnings stay warnings: a quest
 *           whose flag nothing sets is often a quest whose flag ENGINE CODE
 *           sets, and no release should be blocked by a guess.
 *
 * THREE CHECKS HERE ARE HEURISTICS AND SAY SO. Actions live inside
 * type-specific bodies this file does not know the shape of, so the reachability
 * check finds them with a generic deep walk over the parsed body, keys on the
 * `flag` NAME CONVENTION from types.ts (`{ "do": "flag.set", "flag": "met-gain" }`),
 * and cannot see a flag set by engine code at all. Every one of those is a
 * reason to be wrong in the direction of noise, which is why the finding is a
 * `warn` and why `engineFlags` exists to silence the third — a flag the engine
 * owns is a legitimate, common case, not an oversight.
 */

import type {
  Action,
  Condition,
  ContentAsset,
  ContentId,
  ContentLookup,
  ContentTypeDef,
  ContentTypeName,
  Diagnostic,
  Severity,
} from './types';
import { compareIds, parseId } from './ids';
import { DiagnosticSink, atLeast } from './diagnostics';
import type { DiagCode } from './diagnostics';
import { isRecord } from './schema';

// ---------------------------------------------------------------------------
// What the validator is given
// ---------------------------------------------------------------------------

/**
 * The read side of a load, narrowed to what this pass needs.
 *
 * Declared here rather than imported from the registry on purpose: this file is
 * the guard tool's entry point as much as the runtime's, and a tool that has
 * only parsed JSON on disk can satisfy four methods without constructing a
 * registry. `ContentLookup` in types.ts is nearly this and is missing the one
 * thing a whole-graph pass cannot do without — a way to ENUMERATE, which
 * `types()` supplies.
 */
export interface Loaded {
  /** Every loaded asset of a type. */
  all(type: ContentTypeName): readonly ContentAsset[];
  get(id: ContentId): ContentAsset | undefined;
  /** Every registered type name — what `all` may be asked for. */
  types(): readonly ContentTypeName[];
  /** The registration, when the caller has it. Its `validate` runs last. */
  typeDef?(type: ContentTypeName): ContentTypeDef | undefined;
}

export type ValidationLevel = 'dev' | 'check' | 'ship';

export interface ValidateOptions {
  /** What an error costs. See the header. Default `'dev'`. */
  readonly level?: ValidationLevel;
  /**
   * Flags engine code sets, which no content anywhere writes.
   *
   * The reachability check cannot see a `setFlag` in `main.ts`, so without this
   * every engine-owned flag reads as a quest that can never start. Supplying the
   * list is how a caller turns a true statement ("no CONTENT sets this") into a
   * useful one.
   */
  readonly engineFlags?: readonly string[];
  /** Types whose assets must carry a display name. */
  readonly requireName?: readonly ContentTypeName[];
  /** Registered condition tests. Omit to skip the `unknown-test` check. */
  readonly tests?: readonly string[];
  /** Registered action handlers. Omit to skip the `unknown-action` check. */
  readonly actions?: readonly string[];
  /**
   * Orphan detection, delegated: the reverse index lives in graph.ts and this
   * pass has no business rebuilding it. Omit to skip.
   */
  readonly orphans?: () => readonly ContentId[];
  /**
   * "This id is allowed to be missing" — a reference into a package that loads
   * later, or an optional pack. Answers `true` to demote `missing-ref` to info.
   */
  readonly optionalRef?: (id: ContentId) => boolean;
  /** Is this a key the shipped string table has? Supplied by a caller who can see it. */
  readonly knownTextKey?: (key: string) => boolean;
  /** Collect into an existing sink instead of a fresh one. */
  readonly sink?: DiagnosticSink;
}

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

/** How deep the generic body walk descends looking for actions. */
const WALK_DEPTH = 24;
/** How many nodes it visits per asset, so one enormous body cannot stall a boot. */
const WALK_NODES = 20000;
/** How deep a condition tree is walked. Matches `LIMITS.maxConditionDepth`. */
const COND_DEPTH = 16;

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/**
 * Validate a whole load. Never throws; returns the findings, worst first.
 *
 * Two passes over the assets, and the order is forced: the reachability check
 * asks "does anything, anywhere, set this flag", which cannot be answered while
 * still walking the assets that might.
 */
export function validateContent(
  loaded: Loaded,
  opts: ValidateOptions = {},
): readonly Diagnostic[] {
  const sink = opts.sink ?? new DiagnosticSink();
  const level = opts.level ?? 'dev';

  const registered = new Set<ContentTypeName>(loaded.types());
  const byId = new Map<ContentId, ContentAsset>();
  const assets: ContentAsset[] = [];

  // --- pass 1: gather, and catch the two things gathering can see -----------
  const setFlags = new Set<string>(opts.engineFlags ?? []);
  const knownTests = opts.tests ? new Set(opts.tests) : undefined;
  const knownActions = opts.actions ? new Set(opts.actions) : undefined;

  for (const type of registered) {
    for (const asset of loaded.all(type)) {
      const first = byId.get(asset.id);
      if (first !== undefined) {
        // Same object under two type buckets is a broken envelope, not a
        // duplicate; that is `bad-id` below and is reported once there.
        if (first !== asset) {
          report(sink, asset, 'error', 'duplicate-id', `also defined by package "${first.pkg}"`, {
            fix: 'rename one — an id is what a save game stores',
            related: [first.id],
          });
        }
        continue;
      }
      byId.set(asset.id, asset);
      assets.push(asset);
      collectSetFlags(asset, setFlags);
    }
  }

  // --- pass 2: everything that needs the whole table ------------------------
  for (const asset of assets) {
    checkEnvelope(sink, asset, registered, loaded);
    checkRefs(sink, asset, loaded, registered, opts);
    checkWhen(sink, asset, loaded, registered, setFlags, knownTests, opts);
    checkActions(sink, asset, knownActions);
    checkText(sink, asset, opts);

    const def = loaded.typeDef?.(asset.type);
    if (def) {
      if (typeof asset.schema === 'number' && asset.schema > def.schema) {
        report(
          sink,
          asset,
          'error',
          'unsupported-schema',
          `written against schema ${asset.schema}; this build reads ${def.schema}`,
          { field: 'schema', fix: 'update the game, or author against the older revision' },
        );
      }
      // The type's OWN cross-asset rules — "a town's layout must be one the
      // builder registry has". Reference existence is checked centrally above,
      // deliberately, so a type never has to reimplement it (types.ts).
      def.validate?.(asset, sink.validateCtx(lookupOf(loaded), {
        assetId: asset.id,
        assetType: asset.type,
        pkg: asset.pkg,
        source: asset.source,
      }));
    }
  }

  // --- orphans, from the graph ---------------------------------------------
  if (opts.orphans) {
    for (const id of [...opts.orphans()].sort(compareIds)) {
      const asset = byId.get(id);
      report(sink, asset, 'warn', 'orphan', 'nothing references this and no system enumerates it', {
        assetId: id,
        fix: 'reference it, tag it for a system that enumerates by tag, or delete it',
      });
    }
  }

  return escalate(sink.sorted(), level);
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

function checkEnvelope(
  sink: DiagnosticSink,
  asset: ContentAsset,
  registered: ReadonlySet<ContentTypeName>,
  loaded: Loaded,
): void {
  const parsed = parseId(asset.id);
  if (parsed === null) {
    report(sink, asset, 'error', 'bad-id', `"${asset.id}" is not a well-formed content id`, {
      field: 'id',
      fix: 'ids are "type:name", lower-case a-z 0-9 and -',
    });
    return;
  }
  // `type` is DERIVED from `id` and never authored twice (types.ts). A mismatch
  // therefore means the envelope was built wrong, not that content is wrong —
  // which is exactly the kind of thing that is invisible until a query by type
  // silently returns nothing.
  if (asset.type !== parsed.type) {
    report(
      sink,
      asset,
      'error',
      'bad-id',
      `type is "${asset.type}" but the id says "${parsed.type}"`,
      { field: 'type', fix: 'derive type from the id; never author it' },
    );
  }
  if (!registered.has(parsed.type) && loaded.typeDef?.(parsed.type) === undefined) {
    report(sink, asset, 'error', 'unknown-type', `no type "${parsed.type}" is registered`, {
      field: 'id',
      fix: `call defineType({ name: "${parsed.type}", … }) before loading this package`,
    });
  }
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

function checkRefs(
  sink: DiagnosticSink,
  asset: ContentAsset,
  loaded: Loaded,
  registered: ReadonlySet<ContentTypeName>,
  opts: ValidateOptions,
): void {
  for (let i = 0; i < asset.refs.length; i++) {
    const ref = asset.refs[i];
    // The empty string is schema.ts's `id()` FALLBACK, and the field it came
    // from was already reported where it was read. Complaining again here would
    // charge one typo two diagnostics, in two different vocabularies — the
    // author's field name, and an index into a list they never wrote.
    if (ref === '') continue;
    checkOneRef(sink, asset, ref, `refs[${i}]`, loaded, registered, opts, 'error');
  }
}

/**
 * One reference: is it an id, does its type half name a registered type, does it
 * resolve, and does the thing it resolves to agree about its own type.
 *
 * The middle question is the cheap one that catches the most: a ref's type half
 * is checkable with NO lookup, so `spawns: ["enemey:gloopling"]` is caught even
 * when the package defining enemies has not loaded yet — see the note on
 * `ContentId` in types.ts for why the type lives inside the id.
 */
function checkOneRef(
  sink: DiagnosticSink,
  asset: ContentAsset,
  ref: ContentId,
  field: string,
  loaded: Loaded,
  registered: ReadonlySet<ContentTypeName>,
  opts: ValidateOptions,
  severity: Severity,
): void {
  const parsed = parseId(ref);
  if (parsed === null) {
    report(sink, asset, severity, 'bad-id', `"${ref}" is not a well-formed content id`, { field });
    return;
  }
  if (!registered.has(parsed.type) && loaded.typeDef?.(parsed.type) === undefined) {
    report(
      sink,
      asset,
      severity,
      'unknown-type',
      `"${ref}" names the content type "${parsed.type}", which nothing registered`,
      { field, fix: 'check the spelling of the type half' },
    );
    return;
  }
  const target = loaded.get(ref);
  if (target === undefined) {
    const optional = opts.optionalRef?.(ref) === true;
    report(
      sink,
      asset,
      optional ? 'info' : severity,
      'missing-ref',
      optional
        ? `"${ref}" is not loaded (declared optional)`
        : `nothing defines "${ref}"`,
      {
        field,
        related: [ref],
        fix: optional ? undefined : 'add it, load the package that defines it, or drop the reference',
      },
    );
    return;
  }
  if (target.type !== parsed.type) {
    report(
      sink,
      asset,
      severity,
      'wrong-ref-type',
      `"${ref}" resolves to a "${target.type}"`,
      { field, related: [ref] },
    );
  }
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

function checkWhen(
  sink: DiagnosticSink,
  asset: ContentAsset,
  loaded: Loaded,
  registered: ReadonlySet<ContentTypeName>,
  setFlags: ReadonlySet<string>,
  knownTests: ReadonlySet<string> | undefined,
  opts: ValidateOptions,
): void {
  if (asset.when === undefined) return;
  const leaves: Leaf[] = [];
  walkCondition(asset.when, 'when', 0, leaves);

  const declared = new Set(asset.refs);
  for (const leaf of leaves) {
    if (knownTests && !knownTests.has(leaf.test)) {
      report(sink, asset, 'error', 'unknown-test', `no test "${leaf.test}" is registered`, {
        field: `${leaf.path}.test`,
        // types.ts: an unknown test evaluates FALSE, so the symptom is content
        // that never appears rather than content that appears wrongly.
        fix: 'check the spelling — an unknown test is false, so this can never pass',
      });
    }
    // Ids hiding in a leaf's parameters. Only strings that parse as an id AND
    // whose type half names a REGISTERED type are treated as references, which
    // is what keeps a parameter like "time:noon" out of it.
    for (const [key, value] of Object.entries(leaf.params)) {
      if (typeof value !== 'string' || declared.has(value)) continue;
      const p = parseId(value);
      if (p === null || !registered.has(p.type)) continue;
      checkOneRef(sink, asset, value, `${leaf.path}.${key}`, loaded, registered, opts, 'warn');
    }
  }

  // --- can this ever pass? -------------------------------------------------
  for (const flag of requiredFlags(asset.when, 0)) {
    if (setFlags.has(flag)) continue;
    report(
      sink,
      asset,
      'warn',
      'never-available',
      `requires the flag "${flag}", which no loaded content sets`,
      {
        field: 'when',
        fix:
          `set it from an action ({ "do": "flag.set", "flag": "${flag}" }), ` +
          'or list it in the engine-set flags if engine code owns it',
      },
    );
  }
}

interface Leaf {
  readonly test: string;
  readonly params: Readonly<Record<string, unknown>>;
  /** Dotted path to the leaf — `when.all[1]`. */
  readonly path: string;
}

/** Every leaf in a condition tree, however nested. Structure is not re-checked here. */
function walkCondition(value: unknown, path: string, depth: number, out: Leaf[]): void {
  if (depth > COND_DEPTH || !isRecord(value)) return;
  const all = value.all;
  const any = value.any;
  if (Array.isArray(all) || Array.isArray(any)) {
    const key = Array.isArray(all) ? 'all' : 'any';
    const parts: readonly unknown[] = Array.isArray(all) ? all : (any as readonly unknown[]);
    for (let i = 0; i < parts.length; i++) {
      walkCondition(parts[i], `${path}.${key}[${i}]`, depth + 1, out);
    }
    return;
  }
  if (value.not !== undefined) {
    walkCondition(value.not, `${path}.not`, depth + 1, out);
    return;
  }
  if (typeof value.test === 'string') {
    const params: Record<string, unknown> = {};
    for (const k of Object.keys(value)) if (k !== 'test') params[k] = value[k];
    out.push({ test: value.test, params, path });
  }
}

/**
 * Flags that MUST be set for a condition to pass.
 *
 * Deliberately conservative: it descends through `all` and stops dead at `any`
 * and at `not`. A flag under an `any` has an alternative that may be reachable,
 * and a flag under a `not` makes the condition pass when it is NOT set — so a
 * flag nothing sets is the reason that branch is always TRUE, which is the
 * opposite finding. Reporting either would be a false positive on correct
 * content, and a warning that cries wolf is a warning people learn to filter.
 */
function requiredFlags(when: Condition | undefined, depth: number): readonly string[] {
  const out: string[] = [];
  collectRequired(when, depth, out);
  return out;
}

function collectRequired(value: unknown, depth: number, out: string[]): void {
  if (depth > COND_DEPTH || !isRecord(value)) return;
  if (Array.isArray(value.all)) {
    for (const part of value.all) collectRequired(part, depth + 1, out);
    return;
  }
  if (value.any !== undefined || value.not !== undefined) return;
  // The name convention from types.ts: `{ "test": "flag", "flag": "met-gain" }`.
  // Keyed on the PARAMETER rather than the test name, so a `flag-any` or a
  // `flag-since` test written later is covered without editing this.
  if (typeof value.test === 'string' && typeof value.flag === 'string' && value.flag !== '') {
    out.push(value.flag);
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Every flag any action in this asset SETS, found by a generic walk of the
 * parsed body.
 *
 * A walk rather than a lookup because actions live wherever a type puts them —
 * a dialogue choice, a quest reward, an interaction — and this file knows no
 * type's shape by design (that is the extension seam in types.ts). The cost of
 * that is the false positives named in the header, and the reason every finding
 * built on it is a warning.
 */
function collectSetFlags(asset: ContentAsset, into: Set<string>): void {
  walkActions(asset.data, 'data', 0, { n: 0 }, (action) => {
    if (typeof action.do !== 'string') return;
    // `flag.set`, `flag.clear` — clearing still proves the name is real content
    // and not a typo, which is all the reachability check needs to know.
    if (!action.do.startsWith('flag.')) return;
    const flag = action.flag;
    if (typeof flag === 'string' && flag !== '') into.add(flag);
  });
}

function checkActions(
  sink: DiagnosticSink,
  asset: ContentAsset,
  knownActions: ReadonlySet<string> | undefined,
): void {
  if (!knownActions) return;
  walkActions(asset.data, 'data', 0, { n: 0 }, (action, path) => {
    if (typeof action.do !== 'string' || knownActions.has(action.do)) return;
    report(sink, asset, 'warn', 'unknown-action', `no handler "${action.do}" is registered`, {
      field: `${path}.do`,
      // A warn, not an error: this walk finds any object with a `do` key, so a
      // type that happens to name a field `do` would be reported here. The
      // authoritative check is the one the runtime makes when the action runs.
      fix: 'check the spelling, or defineAction it — an unknown action is skipped',
    });
  });
}

/** Any object carrying a `do` key, anywhere in a body. Depth- and node-capped. */
function walkActions(
  value: unknown,
  path: string,
  depth: number,
  budget: { n: number },
  visit: (action: Readonly<Record<string, unknown>>, path: string) => void,
): void {
  if (depth > WALK_DEPTH || budget.n >= WALK_NODES) return;
  if (value === null || typeof value !== 'object') return;
  budget.n++;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      walkActions(value[i], `${path}[${i}]`, depth + 1, budget, visit);
    }
    return;
  }
  if (!isRecord(value)) return;
  if (typeof value.do === 'string') visit(value, path);
  for (const k of Object.keys(value)) {
    walkActions(value[k], `${path}.${k}`, depth + 1, budget, visit);
  }
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * A type that shows a name must have one.
 *
 * The failure this prevents is the one issue #17 is about from the other end: a
 * settlement whose sign is blank does not read as missing content, it reads as a
 * broken HUD — and a blank is the one defect a screenshot cannot distinguish
 * from a rendering bug.
 */
function checkText(sink: DiagnosticSink, asset: ContentAsset, opts: ValidateOptions): void {
  const needs = opts.requireName;
  if (!needs || !needs.includes(asset.type)) return;
  if (asset.name === undefined) {
    report(sink, asset, 'error', 'missing-text', `a ${asset.type} must have a display name`, {
      field: 'name',
      fix: 'add { "key": "…" } from src/i18n/en.ts, or { "text": { "en": "…" } }',
    });
    return;
  }
  if ('key' in asset.name && opts.knownTextKey && !opts.knownTextKey(asset.name.key)) {
    report(sink, asset, 'error', 'missing-text', `"${asset.name.key}" is not in the string table`, {
      field: 'name.key',
      fix: 'add it to src/i18n/en.ts, or carry the words inline with "text"',
    });
  }
}

// ---------------------------------------------------------------------------
// Level
// ---------------------------------------------------------------------------

/**
 * Apply the environment. `ship` promotes every error to fatal; nothing else
 * moves, and nothing is ever filtered out — a report that hid its warnings in
 * one environment would make two runs of the same tool disagree about the same
 * content, which is the property this whole file is trying to keep.
 */
function escalate(diags: readonly Diagnostic[], level: ValidationLevel): readonly Diagnostic[] {
  if (level !== 'ship') return diags;
  return diags.map((d) => (d.severity === 'error' ? { ...d, severity: 'fatal' as const } : d));
}

/** True when this run should fail a build check. */
export function failsCheck(
  diags: readonly Diagnostic[] | DiagnosticSink,
  level: ValidationLevel = 'check',
): boolean {
  const list = diags instanceof DiagnosticSink ? diags.sorted() : diags;
  const bar: Severity = level === 'dev' ? 'fatal' : 'error';
  return list.some((d) => atLeast(d.severity, bar));
}

/** Thrown by `assertLoadable`, carrying what was wrong. */
export class ContentLoadError extends Error {
  constructor(
    message: string,
    readonly diagnostics: readonly Diagnostic[],
  ) {
    super(message);
    this.name = 'ContentLoadError';
  }
}

/**
 * Stop, but only for content the runtime cannot carry on without.
 *
 * THE ONLY THROW IN THIS SYSTEM. See the header: everything short of fatal
 * degrades with a placeholder, because a player mid-session must not lose the
 * session to one bad quest file. Callers are the boot path (where a fatal means
 * the core package did not parse and there is no world) and the packaging tool
 * (where `level: 'ship'` has already promoted every error into this class).
 */
export function assertLoadable(diags: readonly Diagnostic[] | DiagnosticSink): void {
  const list = diags instanceof DiagnosticSink ? diags.sorted() : diags;
  const fatal = list.filter((d) => d.severity === 'fatal');
  if (fatal.length === 0) return;
  const lines = fatal.map(
    (d) => `  ${d.code} ${d.assetId ?? d.pkg ?? ''}${d.field ? ` ${d.field}` : ''}: ${d.message}`,
  );
  throw new ContentLoadError(
    `content: ${fatal.length} fatal problem${fatal.length === 1 ? '' : 's'}\n${lines.join('\n')}`,
    fatal,
  );
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

interface ReportExtra {
  readonly field?: string;
  readonly fix?: string;
  readonly related?: readonly ContentId[];
  readonly assetId?: ContentId;
}

function report(
  sink: DiagnosticSink,
  asset: ContentAsset | undefined,
  severity: Severity,
  code: DiagCode,
  message: string,
  extra: ReportExtra = {},
): void {
  sink.add({
    severity,
    code,
    message,
    assetId: extra.assetId ?? asset?.id,
    assetType: asset?.type,
    pkg: asset?.pkg,
    source: asset?.source,
    field: extra.field,
    fix: extra.fix,
    related: extra.related,
  });
}

/**
 * A `ContentLookup` view of a `Loaded`, for a type's own `validate`.
 *
 * The two assertions are the ones `ContentLookup`'s signature builds in: `get<T>`
 * lets a CALLER name the body type it expects, and no implementation can check
 * that claim — the asset holds `unknown` and the parser that produced it is the
 * only thing that ever knew better. Every implementation of this interface has
 * the same pair; it is not a narrowing of untrusted JSON, which is what this
 * codebase forbids.
 */
function lookupOf(loaded: Loaded): ContentLookup {
  return {
    get: <T = unknown>(id: ContentId) => loaded.get(id) as ContentAsset<T> | undefined,
    all: <T = unknown>(type: ContentTypeName) => loaded.all(type) as readonly ContentAsset<T>[],
    has: (id: ContentId) => loaded.get(id) !== undefined,
  };
}
