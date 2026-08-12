// The cross-asset pass: a parser sees one body, this sees the graph.
// `assertLoadable` is the ONLY throw in the system, and only on `fatal`; everything
// else degrades with a placeholder so one bad file cannot cost a session.
// `level` ESCALATES, never filters: dev as found, check exits non-zero on error,
// ship promotes every error to fatal. Warnings stay warnings.
// The action/flag checks are heuristics over a generic body walk, hence `warn` and
// hence `engineFlags`.

import type {
  Condition,
  ContentAsset,
  ContentId,
  ContentLookup,
  ContentTypeDef,
  ContentTypeName,
  Diagnostic,
  Severity,
} from "./types";
import { compareIds, parseId } from "./ids";
import { DiagnosticSink, atLeast } from "./diagnostics";
import type { DiagCode } from "./diagnostics";
import { isRecord } from "./schema";

// Declared here, not imported: a guard tool with only parsed JSON can satisfy it.
export interface Loaded {
  all(type: ContentTypeName): readonly ContentAsset[];
  get(id: ContentId): ContentAsset | undefined;
  types(): readonly ContentTypeName[];
  /** When the caller has it. Its `validate` runs last. */
  typeDef?(type: ContentTypeName): ContentTypeDef | undefined;
}

export type ValidationLevel = "dev" | "check" | "ship";

export interface ValidateOptions {
  readonly level?: ValidationLevel;
  /** Flags engine code sets: without them every engine-owned flag reads as broken. */
  readonly engineFlags?: readonly string[];
  readonly requireName?: readonly ContentTypeName[];
  /** Both omittable, to skip the `unknown-test` / `unknown-action` checks. */
  readonly tests?: readonly string[];
  readonly actions?: readonly string[];
  /** Delegated: the reverse index lives in graph.ts. Omit to skip. */
  readonly orphans?: () => readonly ContentId[];
  /** True demotes `missing-ref` to info — a package that loads later. */
  readonly optionalRef?: (id: ContentId) => boolean;
  readonly knownTextKey?: (key: string) => boolean;
  readonly sink?: DiagnosticSink;
}

const WALK_DEPTH = 24;
/** Per asset, so one enormous body cannot stall a boot. */
const WALK_NODES = 20000;
/** Matches `LIMITS.maxConditionDepth`. */
const COND_DEPTH = 16;

// Never throws. Two passes, and the order is forced: "does anything set this flag"
// cannot be answered while still walking the assets that might.
export function validateContent(loaded: Loaded, opts: ValidateOptions = {}): readonly Diagnostic[] {
  const sink = opts.sink ?? new DiagnosticSink();
  const level = opts.level ?? "dev";

  const registered = new Set<ContentTypeName>(loaded.types());
  const byId = new Map<ContentId, ContentAsset>();
  const assets: ContentAsset[] = [];

  // pass 1: gather
  const setFlags = new Set<string>(opts.engineFlags ?? []);
  const knownTests = opts.tests ? new Set(opts.tests) : undefined;
  const knownActions = opts.actions ? new Set(opts.actions) : undefined;

  for (const type of registered) {
    for (const asset of loaded.all(type)) {
      const first = byId.get(asset.id);
      if (first !== undefined) {
        // One object under two type buckets is a broken envelope, reported as `bad-id`.
        if (first !== asset) {
          report(sink, asset, "error", "duplicate-id", `also defined by package "${first.pkg}"`, {
            fix: "rename one — an id is what a save game stores",
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

  // pass 2: everything that needs the whole table
  for (const asset of assets) {
    checkEnvelope(sink, asset, registered, loaded);
    checkRefs(sink, asset, loaded, registered, opts);
    checkWhen(sink, asset, loaded, registered, setFlags, knownTests, opts);
    checkActions(sink, asset, knownActions);
    checkText(sink, asset, opts);

    const def = loaded.typeDef?.(asset.type);
    if (def) {
      if (typeof asset.schema === "number" && asset.schema > def.schema) {
        report(
          sink,
          asset,
          "error",
          "unsupported-schema",
          `written against schema ${asset.schema}; this build reads ${def.schema}`,
          { field: "schema", fix: "update the game, or author against the older revision" },
        );
      }
      // The type's OWN rules only: reference existence is checked centrally above.
      def.validate?.(
        asset,
        sink.validateCtx(lookupOf(loaded), {
          assetId: asset.id,
          assetType: asset.type,
          pkg: asset.pkg,
          source: asset.source,
        }),
      );
    }
  }

  if (opts.orphans) {
    for (const id of [...opts.orphans()].toSorted(compareIds)) {
      const asset = byId.get(id);
      report(sink, asset, "warn", "orphan", "nothing references this and no system enumerates it", {
        assetId: id,
        fix: "reference it, tag it for a system that enumerates by tag, or delete it",
      });
    }
  }

  return escalate(sink.sorted(), level);
}

function checkEnvelope(
  sink: DiagnosticSink,
  asset: ContentAsset,
  registered: ReadonlySet<ContentTypeName>,
  loaded: Loaded,
): void {
  const parsed = parseId(asset.id);
  if (parsed === null) {
    report(sink, asset, "error", "bad-id", `"${asset.id}" is not a well-formed content id`, {
      field: "id",
      fix: 'ids are "type:name", lower-case a-z 0-9 and -',
    });
    return;
  }
  // A mismatch means the ENVELOPE was built wrong, and is invisible until a query
  // by type returns nothing.
  if (asset.type !== parsed.type) {
    report(
      sink,
      asset,
      "error",
      "bad-id",
      `type is "${asset.type}" but the id says "${parsed.type}"`,
      { field: "type", fix: "derive type from the id; never author it" },
    );
  }
  if (!registered.has(parsed.type) && loaded.typeDef?.(parsed.type) === undefined) {
    report(sink, asset, "error", "unknown-type", `no type "${parsed.type}" is registered`, {
      field: "id",
      fix: `call defineType({ name: "${parsed.type}", … }) before loading this package`,
    });
  }
}

function checkRefs(
  sink: DiagnosticSink,
  asset: ContentAsset,
  loaded: Loaded,
  registered: ReadonlySet<ContentTypeName>,
  opts: ValidateOptions,
): void {
  for (let i = 0; i < asset.refs.length; i++) {
    const ref = asset.refs[i];
    // '' is schema.ts's `id()` fallback, already reported at the field it came from.
    if (ref === "") {
      continue;
    }
    checkOneRef(sink, asset, ref, `refs[${i}]`, loaded, registered, opts, "error");
  }
}

// The type half is checkable with NO lookup, so a misspelled type is caught even
// before the package defining it loads.
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
    report(sink, asset, severity, "bad-id", `"${ref}" is not a well-formed content id`, { field });
    return;
  }
  if (!registered.has(parsed.type) && loaded.typeDef?.(parsed.type) === undefined) {
    report(
      sink,
      asset,
      severity,
      "unknown-type",
      `"${ref}" names the content type "${parsed.type}", which nothing registered`,
      { field, fix: "check the spelling of the type half" },
    );
    return;
  }
  const target = loaded.get(ref);
  if (target === undefined) {
    const optional = opts.optionalRef?.(ref) === true;
    report(
      sink,
      asset,
      optional ? "info" : severity,
      "missing-ref",
      optional ? `"${ref}" is not loaded (declared optional)` : `nothing defines "${ref}"`,
      {
        field,
        related: [ref],
        fix: optional
          ? undefined
          : "add it, load the package that defines it, or drop the reference",
      },
    );
    return;
  }
  if (target.type !== parsed.type) {
    report(sink, asset, severity, "wrong-ref-type", `"${ref}" resolves to a "${target.type}"`, {
      field,
      related: [ref],
    });
  }
}

function checkWhen(
  sink: DiagnosticSink,
  asset: ContentAsset,
  loaded: Loaded,
  registered: ReadonlySet<ContentTypeName>,
  setFlags: ReadonlySet<string>,
  knownTests: ReadonlySet<string> | undefined,
  opts: ValidateOptions,
): void {
  if (asset.when === undefined) {
    return;
  }
  const leaves: Leaf[] = [];
  walkCondition(asset.when, "when", 0, leaves);

  const declared = new Set(asset.refs);
  for (const leaf of leaves) {
    if (knownTests && !knownTests.has(leaf.test)) {
      report(sink, asset, "error", "unknown-test", `no test "${leaf.test}" is registered`, {
        field: `${leaf.path}.test`,
        fix: "check the spelling — an unknown test is false, so this can never pass",
      });
    }
    // Ids hiding in leaf params: a REGISTERED type half is what keeps a parameter
    // like "time:noon" out of it.
    for (const [key, value] of Object.entries(leaf.params)) {
      if (typeof value !== "string" || declared.has(value)) {
        continue;
      }
      const p = parseId(value);
      if (p === null || !registered.has(p.type)) {
        continue;
      }
      checkOneRef(sink, asset, value, `${leaf.path}.${key}`, loaded, registered, opts, "warn");
    }
  }

  for (const flag of requiredFlags(asset.when, 0)) {
    if (setFlags.has(flag)) {
      continue;
    }
    report(
      sink,
      asset,
      "warn",
      "never-available",
      `requires the flag "${flag}", which no loaded content sets`,
      {
        field: "when",
        fix:
          `set it from an action ({ "do": "flag.set", "flag": "${flag}" }), ` +
          "or list it in the engine-set flags if engine code owns it",
      },
    );
  }
}

interface Leaf {
  readonly test: string;
  readonly params: Readonly<Record<string, unknown>>;
  /** Dotted path — `when.all[1]`. */
  readonly path: string;
}

function walkCondition(value: unknown, path: string, depth: number, out: Leaf[]): void {
  if (depth > COND_DEPTH || !isRecord(value)) {
    return;
  }
  const all = value.all;
  const any = value.any;
  if (Array.isArray(all) || Array.isArray(any)) {
    const key = Array.isArray(all) ? "all" : "any";
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
  if (typeof value.test === "string") {
    const params: Record<string, unknown> = {};
    for (const k of Object.keys(value)) {
      if (k !== "test") {
        params[k] = value[k];
      }
    }
    out.push({ test: value.test, params, path });
  }
}

// Conservative: descends `all`, stops dead at `any` and `not`, where an unset flag
// is not evidence of anything (under `not` it makes the branch always TRUE).
function requiredFlags(when: Condition | undefined, depth: number): readonly string[] {
  const out: string[] = [];
  collectRequired(when, depth, out);
  return out;
}

function collectRequired(value: unknown, depth: number, out: string[]): void {
  if (depth > COND_DEPTH || !isRecord(value)) {
    return;
  }
  if (Array.isArray(value.all)) {
    for (const part of value.all) {
      collectRequired(part, depth + 1, out);
    }
    return;
  }
  if (value.any !== undefined || value.not !== undefined) {
    return;
  }
  // Keyed on the PARAMETER, not the test name, so a later `flag-*` test is covered.
  if (typeof value.test === "string" && typeof value.flag === "string" && value.flag !== "") {
    out.push(value.flag);
  }
}

// A generic walk, not a lookup: actions live wherever a type puts them and this file
// knows no type's shape. Hence the false positives, hence every finding is a warn.
function collectSetFlags(asset: ContentAsset, into: Set<string>): void {
  walkActions(asset.data, "data", 0, { n: 0 }, (action) => {
    if (typeof action.do !== "string") {
      return;
    }
    // `flag.clear` counts too: it still proves the name is real content, not a typo.
    if (!action.do.startsWith("flag.")) {
      return;
    }
    const flag = action.flag;
    if (typeof flag === "string" && flag !== "") {
      into.add(flag);
    }
  });
}

function checkActions(
  sink: DiagnosticSink,
  asset: ContentAsset,
  knownActions: ReadonlySet<string> | undefined,
): void {
  if (!knownActions) {
    return;
  }
  walkActions(asset.data, "data", 0, { n: 0 }, (action, path) => {
    if (typeof action.do !== "string" || knownActions.has(action.do)) {
      return;
    }
    report(sink, asset, "warn", "unknown-action", `no handler "${action.do}" is registered`, {
      field: `${path}.do`,
      // A warn: the walk finds ANY object with a `do` key, so a field named `do`
      // lands here too. The runtime's own check is authoritative.
      fix: "check the spelling, or defineAction it — an unknown action is skipped",
    });
  });
}

function walkActions(
  value: unknown,
  path: string,
  depth: number,
  budget: { n: number },
  visit: (action: Readonly<Record<string, unknown>>, path: string) => void,
): void {
  if (depth > WALK_DEPTH || budget.n >= WALK_NODES) {
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  budget.n++;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      walkActions(value[i], `${path}[${i}]`, depth + 1, budget, visit);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (typeof value.do === "string") {
    visit(value, path);
  }
  for (const k of Object.keys(value)) {
    walkActions(value[k], `${path}.${k}`, depth + 1, budget, visit);
  }
}

// A type that shows a name must have one: a blank label (issue #17) reads as a
// rendering bug rather than as missing content.
function checkText(sink: DiagnosticSink, asset: ContentAsset, opts: ValidateOptions): void {
  const needs = opts.requireName;
  if (!needs || !needs.includes(asset.type)) {
    return;
  }
  if (asset.name === undefined) {
    report(sink, asset, "error", "missing-text", `a ${asset.type} must have a display name`, {
      field: "name",
      fix: 'add { "key": "…" } from src/i18n/en.ts, or { "text": { "en": "…" } }',
    });
    return;
  }
  if ("key" in asset.name && opts.knownTextKey && !opts.knownTextKey(asset.name.key)) {
    report(sink, asset, "error", "missing-text", `"${asset.name.key}" is not in the string table`, {
      field: "name.key",
      fix: 'add it to src/i18n/en.ts, or carry the words inline with "text"',
    });
  }
}

// `ship` promotes error to fatal. Nothing is ever filtered: two runs must agree.
function escalate(diags: readonly Diagnostic[], level: ValidationLevel): readonly Diagnostic[] {
  if (level !== "ship") {
    return diags;
  }
  return diags.map((d) => (d.severity === "error" ? { ...d, severity: "fatal" as const } : d));
}

export function failsCheck(
  diags: readonly Diagnostic[] | DiagnosticSink,
  level: ValidationLevel = "check",
): boolean {
  const list = diags instanceof DiagnosticSink ? diags.sorted() : diags;
  const bar: Severity = level === "dev" ? "fatal" : "error";
  return list.some((d) => atLeast(d.severity, bar));
}

export class ContentLoadError extends Error {
  constructor(
    message: string,
    readonly diagnostics: readonly Diagnostic[],
  ) {
    super(message);
    this.name = "ContentLoadError";
  }
}

// THE ONLY THROW IN THIS SYSTEM. Called by the boot path and the packaging tool,
// never per asset.
export function assertLoadable(diags: readonly Diagnostic[] | DiagnosticSink): void {
  const list = diags instanceof DiagnosticSink ? diags.sorted() : diags;
  const fatal = list.filter((d) => d.severity === "fatal");
  if (fatal.length === 0) {
    return;
  }
  const lines = fatal.map(
    (d) => `  ${d.code} ${d.assetId ?? d.pkg ?? ""}${d.field ? ` ${d.field}` : ""}: ${d.message}`,
  );
  throw new ContentLoadError(
    `content: ${fatal.length} fatal problem${fatal.length === 1 ? "" : "s"}\n${lines.join("\n")}`,
    fatal,
  );
}

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

// The two casts are the ones `ContentLookup`'s own signature builds in — a caller
// naming its expected body type, not a narrowing of untrusted JSON.
function lookupOf(loaded: Loaded): ContentLookup {
  return {
    get: <T = unknown>(id: ContentId) => loaded.get(id) as ContentAsset<T> | undefined,
    all: <T = unknown>(type: ContentTypeName) => loaded.all(type) as readonly ContentAsset<T>[],
    has: (id: ContentId) => loaded.get(id) !== undefined,
  };
}
