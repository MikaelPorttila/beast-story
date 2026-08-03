/**
 * A structural checker for authored bodies — small, composable, dependency-free.
 *
 * NO VALIDATION LIBRARY, and that is this project's oldest rule rather than a
 * preference about zod: `package.json` carries three runtime lines and the
 * architecture note in AGENTS.md says every model, animation and effect is
 * generated in code. The shapes here are a dozen fields wide. A schema library
 * would be the largest dependency in the tree, bought to describe records that
 * fit on a screen, and it would own the one thing this file exists to control —
 * the DIAGNOSTIC. What comes out the other side of a reader is not a thrown
 * `ZodError` with a machine path, it is a `Diagnostic` with a code a tool
 * matches, a field path an author can find and a sentence saying what to do.
 *
 * A READER NEVER THROWS AND NEVER RETURNS `undefined` BY ACCIDENT. It reports
 * and returns a documented FALLBACK, because the loader's contract (types.ts,
 * `ParseCtx`) is that one bad field costs one diagnostic and the rest of the
 * package still loads. `opt()` is how a field says it is genuinely optional; a
 * bare reader always produces a value, and every fallback below is chosen so a
 * player or a designer can SEE it rather than wonder:
 *
 *   - text  -> `{{data.name}}`, the path itself, which reads as a placeholder
 *              on screen and names the field to fix;
 *   - color -> magenta, the missing-texture convention, for the same reason;
 *   - when  -> `NEVER`, and that one is not cosmetic — see below;
 *   - list, actions -> empty, i.e. the thing simply does not happen.
 *
 * A MALFORMED CONDITION FAILS CLOSED. `when: undefined` means "always" in the
 * envelope, so returning undefined for a broken `when` would make a typo publish
 * content instead of hiding it. types.ts already argues this for an unknown
 * test — hidden content is a missing quest, visible content is a spoiler or a
 * soft-lock — and the asymmetry is the same here, so `condition()` falls back to
 * `NEVER` rather than to absence.
 *
 * EVERY READER TAKES A PATH, because "a field is the wrong type" is not a
 * diagnostic anybody can act on. `Reader.at()` threads it: `ctx.at('data')
 * .at('spawns').at(2).at('id')` prints `data.spawns[2].id`, and the child is a
 * new object rather than a mutated cursor, so a reader that recurses cannot
 * corrupt its caller's path on the way back out.
 *
 * CAPS THROUGHOUT, because remote JSON is untrusted (spec §22): nesting depth,
 * list length, record width, string length, and the number of complaints one
 * body may generate. A hostile package is not the interesting case — a
 * generated one is. Every cap reports `too-deep` or `too-large` and stops
 * descending, so the cost of refusing a bad document is bounded by the cap and
 * not by the document.
 */

import type {
  Action,
  Condition,
  ContentId,
  ContentText,
  ContentTypeName,
  Diagnostic,
  ParseCtx,
  Severity,
} from './types';
import { isId, parseId } from './ids';
import type { DiagCode } from './diagnostics';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export interface Limits {
  /** How deep `at()` may descend before a container reader refuses. */
  readonly maxDepth: number;
  /** Items in one list. */
  readonly maxItems: number;
  /** Keys in one record, and params on one condition leaf or action. */
  readonly maxKeys: number;
  /** Characters in one authored string. */
  readonly maxStringLen: number;
  /** Nesting of a condition tree specifically — cheaper to blow than `maxDepth`. */
  readonly maxConditionDepth: number;
  /** Findings one body may produce before the rest are dropped. */
  readonly maxReports: number;
}

/**
 * The shipped caps. Every one is far above anything hand-authored and far below
 * anything that costs a frame: the deepest real body in the migrated content is
 * a dialogue tree about six levels down, and a town carries a dozen fields.
 */
export const LIMITS: Limits = {
  maxDepth: 24,
  maxItems: 4096,
  maxKeys: 256,
  maxStringLen: 8192,
  maxConditionDepth: 16,
  maxReports: 200,
};

/** The fallback colour: magenta, the missing-texture convention. */
export const MISSING_COLOR = 0xff00ff;

/**
 * A condition that can never pass — what a malformed `when` becomes.
 *
 * `any` of nothing is false by the same vacuous-quantifier rule that makes `all`
 * of nothing true, so this needs no registered test and no special case in the
 * evaluator. If an evaluator ever disagreed about the empty `any`, this constant
 * is the single place to change, which is why the fallback is a named export and
 * not an object literal at each site.
 */
export const NEVER: Condition = Object.freeze({ any: Object.freeze([]) as readonly Condition[] });

// ---------------------------------------------------------------------------
// The reader context
// ---------------------------------------------------------------------------

/** What every reader is given: where it is, and how to complain about it. */
export interface Reader {
  /** Dotted path from the asset root — `data.spawns[2].id`. */
  readonly path: string;
  /** How many `at()` calls deep. */
  readonly depth: number;
  /** True once `maxDepth` is reached; container readers bail on it. */
  readonly tooDeep: boolean;
  readonly limits: Limits;
  /** A child reader for one field or index. */
  at(field: string | number): Reader;
  /** Report about THIS path. */
  report(severity: Severity, code: DiagCode, message: string, fix?: string): void;
  /**
   * Is this a key the shipped string table has? Supplied by a caller that can
   * see `src/i18n/en.ts`; absent everywhere else, and a `text` reader that is
   * not given one simply does not make the claim. See `text()`.
   */
  readonly knownTextKey?: (key: string) => boolean;
}

/** How a reader's complaints reach a sink. Matches `ParseCtx.report` exactly. */
export type ReportFn = (
  d: Omit<Diagnostic, 'assetId' | 'source'> & { field?: string },
) => void;

export interface ReaderOptions {
  /** Root path. `''` for an asset root, `'data'` when a parser is handed a body. */
  readonly path?: string;
  readonly limits?: Partial<Limits>;
  readonly knownTextKey?: (key: string) => boolean;
}

/** Shared across every child of one root, so the caps are per BODY and not per field. */
interface Budget {
  reports: number;
  capped: boolean;
}

class FieldReader implements Reader {
  readonly knownTextKey?: (key: string) => boolean;

  constructor(
    readonly path: string,
    readonly depth: number,
    readonly limits: Limits,
    private readonly emit: ReportFn,
    private readonly budget: Budget,
    knownTextKey?: (key: string) => boolean,
  ) {
    this.knownTextKey = knownTextKey;
  }

  get tooDeep(): boolean {
    return this.depth >= this.limits.maxDepth;
  }

  at(field: string | number): Reader {
    const path =
      typeof field === 'number'
        ? `${this.path}[${field}]`
        : this.path === ''
          ? field
          : `${this.path}.${field}`;
    return new FieldReader(
      path,
      this.depth + 1,
      this.limits,
      this.emit,
      this.budget,
      this.knownTextKey,
    );
  }

  report(severity: Severity, code: DiagCode, message: string, fix?: string): void {
    if (this.budget.reports >= this.limits.maxReports) {
      // One line saying we stopped, then silence. A body that produced two
      // hundred complaints has one cause, and printing the other nine hundred
      // buries it.
      if (!this.budget.capped) {
        this.budget.capped = true;
        this.emit({
          severity: 'warn',
          code: 'too-many-diagnostics',
          message: `stopped after ${this.limits.maxReports} findings in this asset`,
          fix: 'fix the first ones — they are usually one cause',
        });
      }
      return;
    }
    this.budget.reports++;
    this.emit({ severity, code, message, fix, field: this.path === '' ? undefined : this.path });
  }
}

/** Build a root reader over any report function. */
export function createReader(emit: ReportFn, opts: ReaderOptions = {}): Reader {
  return new FieldReader(
    opts.path ?? '',
    0,
    { ...LIMITS, ...opts.limits },
    emit,
    { reports: 0, capped: false },
    opts.knownTextKey,
  );
}

/** Build a root reader over a `ParseCtx` — what a type's `parse()` does first. */
export function readerFor(ctx: ParseCtx, opts: ReaderOptions = {}): Reader {
  return createReader((d) => ctx.report(d), { path: 'data', ...opts });
}

// ---------------------------------------------------------------------------
// Shared shape tests
// ---------------------------------------------------------------------------

/** A plain object — not null, not an array. The one narrowing every reader starts from. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when the field is there at all. `null` counts as absent — JSON's "no value". */
function present(value: unknown, ctx: Reader, what: string): boolean {
  if (value === undefined || value === null) {
    ctx.report('error', 'missing-field', `${what} is required`, `add "${lastKey(ctx.path)}"`);
    return false;
  }
  return true;
}

function lastKey(path: string): string {
  const i = Math.max(path.lastIndexOf('.'), path.lastIndexOf('['));
  return i < 0 ? path : path.slice(i + 1).replace(/[[\]]/g, '');
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  return `a ${typeof value}`;
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/**
 * A reader: value in, narrowed value (or fallback) out.
 *
 * The scalar readers below take an extra options argument, which keeps them
 * usable as a bare `ReadFn` — `list(str)` is exactly the composition it looks
 * like, because the extra parameter is optional.
 */
export type ReadFn<T> = (value: unknown, ctx: Reader) => T;

export interface StrOptions {
  readonly min?: number;
  readonly max?: number;
  readonly pattern?: RegExp;
  readonly fallback?: string;
  /** What to call it in the message — `"a display name"`. */
  readonly what?: string;
}

export function str(value: unknown, ctx: Reader, o: StrOptions = {}): string {
  const fallback = o.fallback ?? '';
  if (!present(value, ctx, o.what ?? 'a string')) return fallback;
  if (typeof value !== 'string') {
    ctx.report('error', 'bad-field', `expected a string, got ${typeName(value)}`);
    return fallback;
  }
  if (value.length > Math.min(o.max ?? Infinity, ctx.limits.maxStringLen)) {
    ctx.report(
      'error',
      'too-large',
      `string is ${value.length} characters, over the limit of ` +
        `${Math.min(o.max ?? Infinity, ctx.limits.maxStringLen)}`,
    );
    return fallback;
  }
  if (o.min !== undefined && value.length < o.min) {
    ctx.report('error', 'bad-field', `string is shorter than ${o.min} characters`);
    return fallback;
  }
  if (o.pattern && !o.pattern.test(value)) {
    ctx.report('error', 'bad-field', `"${value}" does not match ${String(o.pattern)}`);
    return fallback;
  }
  return value;
}

export interface NumOptions {
  readonly min?: number;
  readonly max?: number;
  readonly fallback?: number;
  readonly what?: string;
}

/**
 * A finite number.
 *
 * OUT OF RANGE CLAMPS rather than falling back, and that is the one place a
 * reader keeps the author's value instead of replacing it: a radius of 10000
 * where the cap is 200 says "as big as it goes", and answering it with the
 * DEFAULT of 19 is a smaller number than the author asked for in a direction
 * they did not ask for. A wrong TYPE has no intent to preserve, so it does not
 * get the same treatment.
 */
export function num(value: unknown, ctx: Reader, o: NumOptions = {}): number {
  const fallback = o.fallback ?? 0;
  if (!present(value, ctx, o.what ?? 'a number')) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    ctx.report('error', 'bad-field', `expected a finite number, got ${typeName(value)}`);
    return fallback;
  }
  if (o.min !== undefined && value < o.min) {
    ctx.report('warn', 'bad-field', `${value} is below the minimum ${o.min}`, 'clamped');
    return o.min;
  }
  if (o.max !== undefined && value > o.max) {
    ctx.report('warn', 'bad-field', `${value} is above the maximum ${o.max}`, 'clamped');
    return o.max;
  }
  return value;
}

/** A whole number. A fractional one is reported and rounded, for the reason `num` clamps. */
export function int(value: unknown, ctx: Reader, o: NumOptions = {}): number {
  const n = num(value, ctx, o);
  if (!Number.isInteger(n)) {
    ctx.report('warn', 'bad-field', `${n} is not a whole number`, 'rounded');
    return Math.round(n);
  }
  return n;
}

export interface BoolOptions {
  readonly fallback?: boolean;
  readonly what?: string;
}

/**
 * A boolean, and only a boolean.
 *
 * `"true"` is NOT accepted. JSON has real booleans, so a quoted one is a
 * mistake somewhere upstream, and quietly accepting it means the day someone
 * writes `"false"` the field reads as true in every language that treats a
 * non-empty string as truthy.
 */
export function bool(value: unknown, ctx: Reader, o: BoolOptions = {}): boolean {
  const fallback = o.fallback ?? false;
  if (!present(value, ctx, o.what ?? 'a true/false value')) return fallback;
  if (typeof value !== 'boolean') {
    ctx.report(
      'error',
      'bad-field',
      `expected true or false, got ${typeName(value)}`,
      typeof value === 'string' ? 'write it unquoted' : undefined,
    );
    return fallback;
  }
  return value;
}

/**
 * A content id.
 *
 * The fallback is the empty string, which `parseId` can never accept — so a
 * downstream reference check sees an id that resolves to nothing rather than an
 * id that resolves to the wrong thing, and the author gets one diagnostic here
 * instead of two.
 */
export function id(value: unknown, ctx: Reader): ContentId {
  if (!present(value, ctx, 'a content id')) return '';
  if (typeof value !== 'string') {
    ctx.report('error', 'bad-id', `expected a content id, got ${typeName(value)}`);
    return '';
  }
  if (!isId(value)) {
    ctx.report(
      'error',
      'bad-id',
      `"${value}" is not a well-formed content id`,
      'ids are "type:name", lower-case a-z 0-9 and -',
    );
    return '';
  }
  return value;
}

/**
 * A content id of exactly one type.
 *
 * This is the check that catches a typo pointing at a REAL asset of the wrong
 * kind — `spawns: ["npc:gloopling"]` — which is the whole reason the type lives
 * inside the id (types.ts, `ContentId`). It costs no lookup, so it works before
 * the target package is loaded.
 */
export function idOf(type: ContentTypeName): ReadFn<ContentId> {
  return (value, ctx) => {
    const raw = id(value, ctx);
    if (raw === '') return raw;
    const p = parseId(raw);
    if (p !== null && p.type !== type) {
      ctx.report(
        'error',
        'wrong-ref-type',
        `expected a "${type}:" id, got "${raw}"`,
        `this field wants a ${type}`,
      );
      return '';
    }
    return raw;
  };
}

/** One of a fixed set of strings. Falls back to the first, which is therefore the default. */
export function enumOf<const V extends readonly string[]>(
  values: V,
  o: { readonly fallback?: V[number] } = {},
): ReadFn<V[number]> {
  return (value, ctx) => {
    const fallback = o.fallback ?? values[0];
    if (!present(value, ctx, `one of ${values.join(', ')}`)) return fallback;
    // `find` rather than `includes` because it is the version that NARROWS: it
    // hands back the member of `values`, so the return type is the union and no
    // assertion is needed to say what the check already proved.
    const found = values.find((v) => v === value);
    if (found === undefined) {
      ctx.report(
        'error',
        'bad-field',
        `expected one of ${values.join(', ')}, got ${JSON.stringify(value)}`,
      );
      return fallback;
    }
    return found;
  };
}

export interface ListOptions {
  readonly min?: number;
  readonly max?: number;
}

/**
 * A list of anything a reader can read.
 *
 * A BAD ITEM DOES NOT KILL THE LIST: three good spawns and one typo yield four
 * entries — the three, plus the item reader's fallback — and one diagnostic
 * naming `spawns[1]`, because the child reader is `ctx.at(i)`.
 *
 * REPLACED RATHER THAN DROPPED, so that the index in the diagnostic still names
 * the item the author wrote. Dropping renumbers everything after the bad one,
 * and "spawns[1] is wrong" then points at a spawn that is fine. For `id` and
 * `idOf` the fallback is the empty string, which can never parse and so can
 * never resolve to the WRONG asset — see `id()`.
 */
export function list<T>(of: ReadFn<T>, o: ListOptions = {}): ReadFn<T[]> {
  return (value, ctx) => {
    if (value === undefined || value === null) {
      ctx.report('error', 'missing-field', 'a list is required', `add "${lastKey(ctx.path)}"`);
      return [];
    }
    if (ctx.tooDeep) {
      ctx.report('error', 'too-deep', `nesting is deeper than ${ctx.limits.maxDepth}`);
      return [];
    }
    if (!Array.isArray(value)) {
      ctx.report('error', 'bad-field', `expected a list, got ${typeName(value)}`);
      return [];
    }
    const cap = Math.min(o.max ?? Infinity, ctx.limits.maxItems);
    if (value.length > cap) {
      ctx.report('error', 'too-large', `list has ${value.length} items, over the limit of ${cap}`);
      return [];
    }
    if (o.min !== undefined && value.length < o.min) {
      ctx.report('error', 'bad-field', `list needs at least ${o.min} items`);
    }
    const out: T[] = [];
    for (let i = 0; i < value.length; i++) out.push(of(value[i], ctx.at(i)));
    return out;
  };
}

export interface RecordOptions {
  readonly max?: number;
  /** Keys must match this — a namespace convention, a language code. */
  readonly key?: RegExp;
}

/** A string-keyed map of anything a reader can read. */
export function record<T>(of: ReadFn<T>, o: RecordOptions = {}): ReadFn<Record<string, T>> {
  return (value, ctx) => {
    const out: Record<string, T> = {};
    if (value === undefined || value === null) {
      ctx.report('error', 'missing-field', 'an object is required', `add "${lastKey(ctx.path)}"`);
      return out;
    }
    if (ctx.tooDeep) {
      ctx.report('error', 'too-deep', `nesting is deeper than ${ctx.limits.maxDepth}`);
      return out;
    }
    if (!isRecord(value)) {
      ctx.report('error', 'bad-field', `expected an object, got ${typeName(value)}`);
      return out;
    }
    const keys = Object.keys(value);
    const cap = Math.min(o.max ?? Infinity, ctx.limits.maxKeys);
    if (keys.length > cap) {
      ctx.report('error', 'too-large', `object has ${keys.length} keys, over the limit of ${cap}`);
      return out;
    }
    for (const k of keys) {
      if (o.key && !o.key.test(k)) {
        ctx.at(k).report('error', 'bad-field', `key "${k}" does not match ${String(o.key)}`);
        continue;
      }
      out[k] = of(value[k], ctx.at(k));
    }
    return out;
  };
}

/**
 * An optional field: absent stays absent, present is read.
 *
 * The one way to say "this may be missing" — every other reader in this file is
 * total, so a field that is genuinely optional is visible at the call site
 * (`opt(body.name, ctx.at('name'), text)`) rather than hidden in a reader's
 * options. That matters because "required" is the common case and the one a
 * reviewer should not have to look up.
 */
export function opt<T>(value: unknown, ctx: Reader, read: ReadFn<T>): T | undefined {
  return value === undefined || value === null ? undefined : read(value, ctx);
}

/** A plain object, unread. For a body a parser will pick apart itself. */
export function obj(value: unknown, ctx: Reader): Record<string, unknown> {
  if (!present(value, ctx, 'an object')) return {};
  if (!isRecord(value)) {
    ctx.report('error', 'bad-field', `expected an object, got ${typeName(value)}`);
    return {};
  }
  return value;
}

// ---------------------------------------------------------------------------
// Localised text
// ---------------------------------------------------------------------------

/** What a missing or malformed `ContentText` becomes: the path, visibly. */
export function placeholderText(path: string): ContentText {
  return { text: { en: `{{${path}}}` } };
}

/**
 * A `ContentText`: exactly one of `key` or `text`.
 *
 * EXACTLY ONE, not "prefer key". Both present means two authors disagreed about
 * where the string lives, and picking one silently is how a translation gets
 * quietly ignored for a release.
 *
 * THE KEY FORM CARRIES ONE UNVERIFIABLE CLAIM, and it is the reason
 * `ContentText` has two shapes at all (types.ts): `StringKey` is `keyof typeof
 * en`, a BUILD-time guarantee, and data authored outside the repo cannot have
 * been checked against the table this build shipped. So the assertion below is
 * the boundary where that guarantee stops — the shape is fully checked at
 * runtime and only the key's MEMBERSHIP is asserted. `Reader.knownTextKey` is
 * the runtime stand-in a caller who can see `src/i18n/en.ts` supplies; without
 * it this reader does not make the claim, and `resolveText` falls back the way
 * `t()` does rather than rendering a blank.
 */
export function text(value: unknown, ctx: Reader): ContentText {
  if (!present(value, ctx, 'a display string')) return placeholderText(ctx.path);
  if (!isRecord(value)) {
    ctx.report(
      'error',
      'bad-field',
      `expected { key } or { text }, got ${typeName(value)}`,
      'write { "key": "town.encampment.name" } or { "text": { "en": "…" } }',
    );
    return placeholderText(ctx.path);
  }
  const hasKey = value.key !== undefined && value.key !== null;
  const hasText = value.text !== undefined && value.text !== null;
  if (hasKey && hasText) {
    ctx.report(
      'error',
      'bad-field',
      'has both "key" and "text"',
      'keep one — "key" for a shipped string, "text" for one carried inline',
    );
    return placeholderText(ctx.path);
  }
  if (!hasKey && !hasText) {
    ctx.report('error', 'missing-text', 'has neither "key" nor "text"');
    return placeholderText(ctx.path);
  }

  if (hasKey) {
    const key = str(value.key, ctx.at('key'), { min: 1, what: 'a string key' });
    if (key === '') return placeholderText(ctx.path);
    if (ctx.knownTextKey && !ctx.knownTextKey(key)) {
      ctx.report(
        'error',
        'missing-text',
        `"${key}" is not in the string table`,
        'add it to src/i18n/en.ts, or carry the words inline with "text"',
      );
      return placeholderText(ctx.path);
    }
    // The one assertion in this file. See the note above: the shape is checked,
    // the membership is not checkable here without importing the table.
    return { key } as Extract<ContentText, { key: unknown }>;
  }

  const langs = record(
    (v, c) => str(v, c, { what: 'a translation' }),
    { key: /^[a-z]{2}(-[a-z0-9]+)*$/i, max: 64 },
  )(value.text, ctx.at('text'));
  // At least one language with actual words in it. An inline text of `{}` or of
  // `{ "en": "" }` renders as nothing at all, which on screen is indistinguishable
  // from a HUD bug — the whole class of defect issue #17 was about.
  const filled = Object.values(langs).some((s) => s.trim() !== '');
  if (!filled) {
    ctx.at('text').report(
      'error',
      'missing-text',
      'no language has any words in it',
      'add at least one, e.g. { "en": "Redbriar" }',
    );
    return placeholderText(ctx.path);
  }
  return { text: langs };
}

// ---------------------------------------------------------------------------
// Conditions and actions
// ---------------------------------------------------------------------------

/**
 * Carry an unread parameter across, bounded.
 *
 * A condition leaf's and an action's parameters belong to the test or the
 * handler, not to us, so they are copied VERBATIM — but a value from a remote
 * package is still untrusted, so the copy is depth- and width-capped. Anything
 * over the cap is dropped with a diagnostic rather than truncated silently.
 */
function guarded(value: unknown, ctx: Reader): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (ctx.tooDeep) {
    ctx.report('error', 'too-deep', `nesting is deeper than ${ctx.limits.maxDepth}`);
    return undefined;
  }
  if (Array.isArray(value)) {
    if (value.length > ctx.limits.maxItems) {
      ctx.report('error', 'too-large', `list has ${value.length} items`);
      return undefined;
    }
    return value.map((v, i) => guarded(v, ctx.at(i)));
  }
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length > ctx.limits.maxKeys) {
    ctx.report('error', 'too-large', `object has ${keys.length} keys`);
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = guarded(value[k], ctx.at(k));
  return out;
}

/** Every key of a leaf except the discriminator, carried across. */
function params(
  value: Record<string, unknown>,
  ctx: Reader,
  discriminator: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value)) {
    if (k === discriminator) continue;
    out[k] = guarded(value[k], ctx.at(k));
  }
  return out;
}

/**
 * An availability condition — structure only.
 *
 * STRUCTURE ONLY is the split that keeps this file free of the registry: whether
 * `test: "flag"` names something registered is a question about the RUNTIME, so
 * it is asked in validate.ts where the registered set is a parameter. Here the
 * question is only whether the shape is one of the four (types.ts, `Condition`)
 * and whether exactly one of them is claimed — `{ all: [...], not: {...} }` is
 * two conditions in a trench coat and there is no defensible way to guess which
 * the author meant.
 */
export function condition(value: unknown, ctx: Reader): Condition {
  return readCondition(value, ctx, 0);
}

function readCondition(value: unknown, ctx: Reader, depth: number): Condition {
  if (depth > ctx.limits.maxConditionDepth) {
    ctx.report(
      'error',
      'too-deep',
      `condition nests deeper than ${ctx.limits.maxConditionDepth}`,
      'flatten it — an "all" of "all"s is one "all"',
    );
    return NEVER;
  }
  if (!present(value, ctx, 'a condition')) return NEVER;
  if (!isRecord(value)) {
    ctx.report(
      'error',
      'bad-field',
      `expected a condition object, got ${typeName(value)}`,
      'one of { all }, { any }, { not } or { test }',
    );
    return NEVER;
  }

  const claimed = (['all', 'any', 'not', 'test'] as const).filter(
    (k) => value[k] !== undefined && value[k] !== null,
  );
  if (claimed.length === 0) {
    ctx.report(
      'error',
      'bad-field',
      'names none of all / any / not / test',
      'a condition is { all: [...] }, { any: [...] }, { not: {...} } or { test: "…" }',
    );
    return NEVER;
  }
  if (claimed.length > 1) {
    ctx.report(
      'error',
      'bad-field',
      `names ${claimed.join(' and ')} at once`,
      'split it — wrap the parts in one { all: [...] }',
    );
    return NEVER;
  }

  const which = claimed[0];
  if (which === 'all' || which === 'any') {
    const raw = value[which];
    const kid = ctx.at(which);
    if (!Array.isArray(raw)) {
      kid.report('error', 'bad-field', `"${which}" must be a list of conditions`);
      return NEVER;
    }
    if (raw.length > kid.limits.maxItems) {
      kid.report('error', 'too-large', `"${which}" has ${raw.length} conditions`);
      return NEVER;
    }
    const parts = raw.map((v, i) => readCondition(v, kid.at(i), depth + 1));
    return which === 'all' ? { all: parts } : { any: parts };
  }
  if (which === 'not') {
    return { not: readCondition(value.not, ctx.at('not'), depth + 1) };
  }

  const name = str(value.test, ctx.at('test'), { min: 1, what: 'a test name' });
  if (name === '') return NEVER;
  // The discriminator goes LAST in the literal, so neither the type nor the
  // runtime can lose it to a parameter — `params` already drops a duplicate,
  // and this is the belt to that pair of braces.
  return { ...params(value, ctx, 'test'), test: name };
}

/**
 * A list of actions.
 *
 * The empty list is the fallback, i.e. NOTHING HAPPENS — the safe failure for
 * the one thing in content that writes to a save. A half-applied action list is
 * worse than none: a quest that took the reward and did not advance is a support
 * ticket, where a button that did nothing is a bug report.
 */
export function actions(value: unknown, ctx: Reader): Action[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    ctx.report(
      'error',
      'bad-field',
      `expected a list of actions, got ${typeName(value)}`,
      'write [ { "do": "flag.set", "flag": "met-gain" } ]',
    );
    return [];
  }
  if (value.length > ctx.limits.maxItems) {
    ctx.report('error', 'too-large', `${value.length} actions`);
    return [];
  }
  const out: Action[] = [];
  for (let i = 0; i < value.length; i++) {
    const kid = ctx.at(i);
    const raw: unknown = value[i];
    if (!isRecord(raw)) {
      kid.report('error', 'bad-field', `expected an action object, got ${typeName(raw)}`);
      continue;
    }
    const name = str(raw.do, kid.at('do'), { min: 1, what: 'an action name' });
    if (name === '') continue;
    out.push({ ...params(raw, kid, 'do'), do: name });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

const HEX_RE = /^(?:#|0x)?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * A colour, as a number — THE MIGRATION SEAM, and it needs saying.
 *
 * Every colour in this codebase is authored as a TypeScript hex literal today
 * (`color: 0xffb45e`, world/towns.ts, and a hundred `new THREE.Color(0x…)`
 * beside it) and JSON has no hex literal. Writing 16757342 in a data file is
 * technically the same colour and is unreadable and unreviewable — nobody spots
 * that a digit moved. So content authors `"#ffb45e"` and this reader hands the
 * engine back the number it already wanted, which means moving a colour out of
 * TypeScript is a copy of the digits and not a conversion anyone has to trust.
 *
 * A NUMBER IS STILL ACCEPTED, because a migration tool that dumps the existing
 * literals straight out produces numbers, and a reader that refused them would
 * make the first step of the migration fail on content that is not wrong.
 *
 * Three-digit shorthand expands the way CSS does (`#f80` -> `0xff8800`), since
 * that is what anyone typing a colour into a JSON file expects.
 */
export function hexColor(value: unknown, ctx: Reader): number {
  if (!present(value, ctx, 'a colour')) return MISSING_COLOR;
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffff) {
      ctx.report(
        'error',
        'bad-field',
        `${value} is not a 0x000000-0xffffff colour`,
        'write it as "#rrggbb"',
      );
      return MISSING_COLOR;
    }
    return value;
  }
  if (typeof value !== 'string') {
    ctx.report('error', 'bad-field', `expected a colour, got ${typeName(value)}`);
    return MISSING_COLOR;
  }
  const m = HEX_RE.exec(value.trim());
  if (!m) {
    ctx.report(
      'error',
      'bad-field',
      `"${value}" is not a colour`,
      'write "#rrggbb", "#rgb" or a 0x000000-0xffffff number',
    );
    return MISSING_COLOR;
  }
  const digits = m[1];
  if (digits.length === 3) {
    const r = digits[0];
    const g = digits[1];
    const b = digits[2];
    return parseInt(`${r}${r}${g}${g}${b}${b}`, 16);
  }
  return parseInt(digits, 16);
}
