// Structural checker for authored bodies. No validation library: the point of this
// file is the DIAGNOSTIC — a code a tool matches, a field path, and a fix.
// A reader never throws: it reports and returns a deliberately VISIBLE fallback, and
// `opt()` is the only way to say a field may be absent. A malformed `when` fails
// CLOSED to `NEVER`, since absent `when` means "always". `at()` returns a NEW child
// reader, so recursion cannot corrupt a caller's path. Caps everywhere, so refusing a
// bad document costs the cap and not the document.

import type {
  Action,
  Condition,
  ContentId,
  ContentText,
  ContentTypeName,
  Diagnostic,
  ParseCtx,
  Severity,
} from "./types";
import { isId, parseId } from "./ids";
import type { DiagCode } from "./diagnostics";

export interface Limits {
  /** How deep `at()` may descend before a container reader refuses. */
  readonly maxDepth: number;
  readonly maxItems: number;
  readonly maxKeys: number;
  readonly maxStringLen: number;
  readonly maxConditionDepth: number;
  readonly maxReports: number;
}

export const LIMITS: Limits = {
  maxDepth: 24,
  maxItems: 4096,
  maxKeys: 256,
  maxStringLen: 8192,
  maxConditionDepth: 16,
  maxReports: 200,
};

export const MISSING_COLOR = 0xff00ff;

// An empty `any` is false, so this needs no registered test. Named, so there is one
// place to change if an evaluator ever disagreed about the empty case.
export const NEVER: Condition = Object.freeze({ any: Object.freeze([]) as readonly Condition[] });

export interface Reader {
  /** Dotted path from the asset root — `data.spawns[2].id`. */
  readonly path: string;
  readonly depth: number;
  /** True once `maxDepth` is reached; container readers bail on it. */
  readonly tooDeep: boolean;
  readonly limits: Limits;
  at(field: string | number): Reader;
  report(severity: Severity, code: DiagCode, message: string, fix?: string): void;
  /** Supplied by a caller that can see `src/i18n/en.ts`; absent elsewhere. */
  readonly knownTextKey?: (key: string) => boolean;
}

export type ReportFn = (d: Omit<Diagnostic, "assetId" | "source"> & { field?: string }) => void;

export interface ReaderOptions {
  /** `''` for an asset root, `'data'` when a parser is handed a body. */
  readonly path?: string;
  readonly limits?: Partial<Limits>;
  readonly knownTextKey?: (key: string) => boolean;
}

/** Shared by every child of one root, so caps are per BODY and not per field. */
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
      typeof field === "number"
        ? `${this.path}[${field}]`
        : this.path === ""
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
      // One line saying we stopped, then silence: they are usually one cause.
      if (!this.budget.capped) {
        this.budget.capped = true;
        this.emit({
          severity: "warn",
          code: "too-many-diagnostics",
          message: `stopped after ${this.limits.maxReports} findings in this asset`,
          fix: "fix the first ones — they are usually one cause",
        });
      }
      return;
    }
    this.budget.reports++;
    this.emit({ severity, code, message, fix, field: this.path === "" ? undefined : this.path });
  }
}

export function createReader(emit: ReportFn, opts: ReaderOptions = {}): Reader {
  return new FieldReader(
    opts.path ?? "",
    0,
    { ...LIMITS, ...opts.limits },
    emit,
    { reports: 0, capped: false },
    opts.knownTextKey,
  );
}

export function readerFor(ctx: ParseCtx, opts: ReaderOptions = {}): Reader {
  return createReader((d) => ctx.report(d), { path: "data", ...opts });
}

/** Not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `null` counts as absent — JSON's "no value". */
function present(value: unknown, ctx: Reader, what: string): boolean {
  if (value === undefined || value === null) {
    ctx.report("error", "missing-field", `${what} is required`, `add "${lastKey(ctx.path)}"`);
    return false;
  }
  return true;
}

function lastKey(path: string): string {
  const i = Math.max(path.lastIndexOf("."), path.lastIndexOf("["));
  return i < 0 ? path : path.slice(i + 1).replace(/[[\]]/g, "");
}

function typeName(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "a list";
  }
  return `a ${typeof value}`;
}

// The scalar readers' options argument is optional, which keeps `list(str)` valid.
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
  const fallback = o.fallback ?? "";
  if (!present(value, ctx, o.what ?? "a string")) {
    return fallback;
  }
  if (typeof value !== "string") {
    ctx.report("error", "bad-field", `expected a string, got ${typeName(value)}`);
    return fallback;
  }
  if (value.length > Math.min(o.max ?? Infinity, ctx.limits.maxStringLen)) {
    ctx.report(
      "error",
      "too-large",
      `string is ${value.length} characters, over the limit of ` +
        `${Math.min(o.max ?? Infinity, ctx.limits.maxStringLen)}`,
    );
    return fallback;
  }
  if (o.min !== undefined && value.length < o.min) {
    ctx.report("error", "bad-field", `string is shorter than ${o.min} characters`);
    return fallback;
  }
  if (o.pattern && !o.pattern.test(value)) {
    ctx.report("error", "bad-field", `"${value}" does not match ${String(o.pattern)}`);
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

// Out of range CLAMPS rather than falling back: the author's intent is preserved.
// A wrong type has no intent to keep, so it does not get the same treatment.
export function num(value: unknown, ctx: Reader, o: NumOptions = {}): number {
  const fallback = o.fallback ?? 0;
  if (!present(value, ctx, o.what ?? "a number")) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    ctx.report("error", "bad-field", `expected a finite number, got ${typeName(value)}`);
    return fallback;
  }
  if (o.min !== undefined && value < o.min) {
    ctx.report("warn", "bad-field", `${value} is below the minimum ${o.min}`, "clamped");
    return o.min;
  }
  if (o.max !== undefined && value > o.max) {
    ctx.report("warn", "bad-field", `${value} is above the maximum ${o.max}`, "clamped");
    return o.max;
  }
  return value;
}

export function int(value: unknown, ctx: Reader, o: NumOptions = {}): number {
  const n = num(value, ctx, o);
  if (!Number.isInteger(n)) {
    ctx.report("warn", "bad-field", `${n} is not a whole number`, "rounded");
    return Math.round(n);
  }
  return n;
}

export interface BoolOptions {
  readonly fallback?: boolean;
  readonly what?: string;
}

// `"true"` is NOT accepted: JSON has real booleans, and accepting quoted ones makes
// `"false"` read as true.
export function bool(value: unknown, ctx: Reader, o: BoolOptions = {}): boolean {
  const fallback = o.fallback ?? false;
  if (!present(value, ctx, o.what ?? "a true/false value")) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    ctx.report(
      "error",
      "bad-field",
      `expected true or false, got ${typeName(value)}`,
      typeof value === "string" ? "write it unquoted" : undefined,
    );
    return fallback;
  }
  return value;
}

// Falls back to '', which `parseId` never accepts, so a downstream check cannot
// resolve it to the WRONG asset.
export function id(value: unknown, ctx: Reader): ContentId {
  if (!present(value, ctx, "a content id")) {
    return "";
  }
  if (typeof value !== "string") {
    ctx.report("error", "bad-id", `expected a content id, got ${typeName(value)}`);
    return "";
  }
  if (!isId(value)) {
    ctx.report(
      "error",
      "bad-id",
      `"${value}" is not a well-formed content id`,
      'ids are "type:name", lower-case a-z 0-9 and -',
    );
    return "";
  }
  return value;
}

// Catches a typo pointing at a REAL asset of the wrong kind, with no lookup — so it
// works before the target package loads.
export function idOf(type: ContentTypeName): ReadFn<ContentId> {
  return (value, ctx) => {
    const raw = id(value, ctx);
    if (raw === "") {
      return raw;
    }
    const p = parseId(raw);
    if (p !== null && p.type !== type) {
      ctx.report(
        "error",
        "wrong-ref-type",
        `expected a "${type}:" id, got "${raw}"`,
        `this field wants a ${type}`,
      );
      return "";
    }
    return raw;
  };
}

/** Falls back to the first value, which is therefore the default. */
export function enumOf<const V extends readonly string[]>(
  values: V,
  o: { readonly fallback?: V[number] } = {},
): ReadFn<V[number]> {
  return (value, ctx) => {
    const fallback = o.fallback ?? values[0];
    if (!present(value, ctx, `one of ${values.join(", ")}`)) {
      return fallback;
    }
    // `find`, not `includes`: it NARROWS, so the union needs no assertion.
    const found = values.find((v) => v === value);
    if (found === undefined) {
      ctx.report(
        "error",
        "bad-field",
        `expected one of ${values.join(", ")}, got ${JSON.stringify(value)}`,
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

// A bad item is REPLACED by its reader's fallback, never dropped: dropping renumbers
// the list and the index in the diagnostic would name a different item.
export function list<T>(of: ReadFn<T>, o: ListOptions = {}): ReadFn<T[]> {
  return (value, ctx) => {
    if (value === undefined || value === null) {
      ctx.report("error", "missing-field", "a list is required", `add "${lastKey(ctx.path)}"`);
      return [];
    }
    if (ctx.tooDeep) {
      ctx.report("error", "too-deep", `nesting is deeper than ${ctx.limits.maxDepth}`);
      return [];
    }
    if (!Array.isArray(value)) {
      ctx.report("error", "bad-field", `expected a list, got ${typeName(value)}`);
      return [];
    }
    const cap = Math.min(o.max ?? Infinity, ctx.limits.maxItems);
    if (value.length > cap) {
      ctx.report("error", "too-large", `list has ${value.length} items, over the limit of ${cap}`);
      return [];
    }
    if (o.min !== undefined && value.length < o.min) {
      ctx.report("error", "bad-field", `list needs at least ${o.min} items`);
    }
    const out: T[] = [];
    for (let i = 0; i < value.length; i++) {
      out.push(of(value[i], ctx.at(i)));
    }
    return out;
  };
}

export interface RecordOptions {
  readonly max?: number;
  /** Keys must match this — a namespace convention, a language code. */
  readonly key?: RegExp;
}

export function record<T>(of: ReadFn<T>, o: RecordOptions = {}): ReadFn<Record<string, T>> {
  return (value, ctx) => {
    const out: Record<string, T> = {};
    if (value === undefined || value === null) {
      ctx.report("error", "missing-field", "an object is required", `add "${lastKey(ctx.path)}"`);
      return out;
    }
    if (ctx.tooDeep) {
      ctx.report("error", "too-deep", `nesting is deeper than ${ctx.limits.maxDepth}`);
      return out;
    }
    if (!isRecord(value)) {
      ctx.report("error", "bad-field", `expected an object, got ${typeName(value)}`);
      return out;
    }
    const keys = Object.keys(value);
    const cap = Math.min(o.max ?? Infinity, ctx.limits.maxKeys);
    if (keys.length > cap) {
      ctx.report("error", "too-large", `object has ${keys.length} keys, over the limit of ${cap}`);
      return out;
    }
    for (const k of keys) {
      if (o.key && !o.key.test(k)) {
        ctx.at(k).report("error", "bad-field", `key "${k}" does not match ${String(o.key)}`);
        continue;
      }
      out[k] = of(value[k], ctx.at(k));
    }
    return out;
  };
}

// The only way to say a field may be missing, and it is visible at the CALL SITE
// rather than hidden in a reader's options.
export function opt<T>(value: unknown, ctx: Reader, read: ReadFn<T>): T | undefined {
  return value === undefined || value === null ? undefined : read(value, ctx);
}

export function obj(value: unknown, ctx: Reader): Record<string, unknown> {
  if (!present(value, ctx, "an object")) {
    return {};
  }
  if (!isRecord(value)) {
    ctx.report("error", "bad-field", `expected an object, got ${typeName(value)}`);
    return {};
  }
  return value;
}

/** A missing or malformed `ContentText` becomes the path, visibly. */
export function placeholderText(path: string): ContentText {
  return { text: { en: `{{${path}}}` } };
}

// Exactly ONE of `key` or `text`: both present means two authors disagreed, and
// picking silently drops a translation. A key's MEMBERSHIP needs `knownTextKey`.
export function text(value: unknown, ctx: Reader): ContentText {
  if (!present(value, ctx, "a display string")) {
    return placeholderText(ctx.path);
  }
  if (!isRecord(value)) {
    ctx.report(
      "error",
      "bad-field",
      `expected { key } or { text }, got ${typeName(value)}`,
      'write { "key": "town.encampment.name" } or { "text": { "en": "…" } }',
    );
    return placeholderText(ctx.path);
  }
  const hasKey = value.key !== undefined && value.key !== null;
  const hasText = value.text !== undefined && value.text !== null;
  if (hasKey && hasText) {
    ctx.report(
      "error",
      "bad-field",
      'has both "key" and "text"',
      'keep one — "key" for a shipped string, "text" for one carried inline',
    );
    return placeholderText(ctx.path);
  }
  if (!hasKey && !hasText) {
    ctx.report("error", "missing-text", 'has neither "key" nor "text"');
    return placeholderText(ctx.path);
  }

  if (hasKey) {
    const key = str(value.key, ctx.at("key"), { min: 1, what: "a string key" });
    if (key === "") {
      return placeholderText(ctx.path);
    }
    if (ctx.knownTextKey && !ctx.knownTextKey(key)) {
      ctx.report(
        "error",
        "missing-text",
        `"${key}" is not in the string table`,
        'add it to src/i18n/en.ts, or carry the words inline with "text"',
      );
      return placeholderText(ctx.path);
    }
    // The one assertion in this file: shape checked, membership not.
    return { key } as Extract<ContentText, { key: unknown }>;
  }

  const langs = record((v, c) => str(v, c, { what: "a translation" }), {
    key: /^[a-z]{2}(-[a-z0-9]+)*$/i,
    max: 64,
  })(value.text, ctx.at("text"));
  // At least one language with words in it: a blank renders as a HUD bug (issue #17).
  const filled = Object.values(langs).some((s) => s.trim() !== "");
  if (!filled) {
    ctx
      .at("text")
      .report(
        "error",
        "missing-text",
        "no language has any words in it",
        'add at least one, e.g. { "en": "Redbriar" }',
      );
    return placeholderText(ctx.path);
  }
  return { text: langs };
}

// A leaf's or action's params belong to its handler, so they are copied VERBATIM —
// but capped, since the value is untrusted. Over the cap is dropped, not truncated.
function guarded(value: unknown, ctx: Reader): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (ctx.tooDeep) {
    ctx.report("error", "too-deep", `nesting is deeper than ${ctx.limits.maxDepth}`);
    return undefined;
  }
  if (Array.isArray(value)) {
    if (value.length > ctx.limits.maxItems) {
      ctx.report("error", "too-large", `list has ${value.length} items`);
      return undefined;
    }
    return value.map((v, i) => guarded(v, ctx.at(i)));
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const keys = Object.keys(value);
  if (keys.length > ctx.limits.maxKeys) {
    ctx.report("error", "too-large", `object has ${keys.length} keys`);
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    out[k] = guarded(value[k], ctx.at(k));
  }
  return out;
}

function params(
  value: Record<string, unknown>,
  ctx: Reader,
  discriminator: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value)) {
    if (k === discriminator) {
      continue;
    }
    out[k] = guarded(value[k], ctx.at(k));
  }
  return out;
}

// STRUCTURE ONLY, which is what keeps this file free of the registry: whether a test
// is registered is validate.ts's question. Exactly one of the four keys may be claimed.
export function condition(value: unknown, ctx: Reader): Condition {
  return readCondition(value, ctx, 0);
}

function readCondition(value: unknown, ctx: Reader, depth: number): Condition {
  if (depth > ctx.limits.maxConditionDepth) {
    ctx.report(
      "error",
      "too-deep",
      `condition nests deeper than ${ctx.limits.maxConditionDepth}`,
      'flatten it — an "all" of "all"s is one "all"',
    );
    return NEVER;
  }
  if (!present(value, ctx, "a condition")) {
    return NEVER;
  }
  if (!isRecord(value)) {
    ctx.report(
      "error",
      "bad-field",
      `expected a condition object, got ${typeName(value)}`,
      "one of { all }, { any }, { not } or { test }",
    );
    return NEVER;
  }

  const claimed = (["all", "any", "not", "test"] as const).filter(
    (k) => value[k] !== undefined && value[k] !== null,
  );
  if (claimed.length === 0) {
    ctx.report(
      "error",
      "bad-field",
      "names none of all / any / not / test",
      'a condition is { all: [...] }, { any: [...] }, { not: {...} } or { test: "…" }',
    );
    return NEVER;
  }
  if (claimed.length > 1) {
    ctx.report(
      "error",
      "bad-field",
      `names ${claimed.join(" and ")} at once`,
      "split it — wrap the parts in one { all: [...] }",
    );
    return NEVER;
  }

  const which = claimed[0];
  if (which === "all" || which === "any") {
    const raw = value[which];
    const kid = ctx.at(which);
    if (!Array.isArray(raw)) {
      kid.report("error", "bad-field", `"${which}" must be a list of conditions`);
      return NEVER;
    }
    if (raw.length > kid.limits.maxItems) {
      kid.report("error", "too-large", `"${which}" has ${raw.length} conditions`);
      return NEVER;
    }
    const parts = raw.map((v, i) => readCondition(v, kid.at(i), depth + 1));
    return which === "all" ? { all: parts } : { any: parts };
  }
  if (which === "not") {
    return { not: readCondition(value.not, ctx.at("not"), depth + 1) };
  }

  const name = str(value.test, ctx.at("test"), { min: 1, what: "a test name" });
  if (name === "") {
    return NEVER;
  }
  // Discriminator LAST, so a parameter cannot overwrite it.
  return { ...params(value, ctx, "test"), test: name };
}

// Falls back to empty — NOTHING HAPPENS, the safe failure for the one thing in
// content that writes to a save. A half-applied list is worse than none.
export function actions(value: unknown, ctx: Reader): Action[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    ctx.report(
      "error",
      "bad-field",
      `expected a list of actions, got ${typeName(value)}`,
      'write [ { "do": "flag.set", "flag": "met-gain" } ]',
    );
    return [];
  }
  if (value.length > ctx.limits.maxItems) {
    ctx.report("error", "too-large", `${value.length} actions`);
    return [];
  }
  const out: Action[] = [];
  for (let i = 0; i < value.length; i++) {
    const kid = ctx.at(i);
    const raw: unknown = value[i];
    if (!isRecord(raw)) {
      kid.report("error", "bad-field", `expected an action object, got ${typeName(raw)}`);
      continue;
    }
    const name = str(raw.do, kid.at("do"), { min: 1, what: "an action name" });
    if (name === "") {
      continue;
    }
    out.push({ ...params(raw, kid, "do"), do: name });
  }
  return out;
}

const HEX_RE = /^(?:#|0x)?([0-9a-f]{3}|[0-9a-f]{6})$/i;

// The migration seam: the engine wants the number a TS hex literal gives and JSON has
// none, so authors write "#ffb45e". A plain number is still accepted (dump tools emit
// those); three-digit shorthand expands as CSS does.
export function hexColor(value: unknown, ctx: Reader): number {
  if (!present(value, ctx, "a colour")) {
    return MISSING_COLOR;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffff) {
      ctx.report(
        "error",
        "bad-field",
        `${value} is not a 0x000000-0xffffff colour`,
        'write it as "#rrggbb"',
      );
      return MISSING_COLOR;
    }
    return value;
  }
  if (typeof value !== "string") {
    ctx.report("error", "bad-field", `expected a colour, got ${typeName(value)}`);
    return MISSING_COLOR;
  }
  const m = HEX_RE.exec(value.trim());
  if (!m) {
    ctx.report(
      "error",
      "bad-field",
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
