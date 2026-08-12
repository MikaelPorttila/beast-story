// `error` is content the runtime carries on WITHOUT; `fatal` is content it cannot,
// and only `assertLoadable` (validate.ts) throws. Tolerance is decided there, by
// `ValidateOptions.level`, never here.
// Codes are a CONTRACT tools match on: renaming one is a migration, not an edit.
// Dedupe is on (code, assetId, field), never the message — two passes word the same
// finding differently. Order is total so two runs diff cleanly.

import type {
  ContentId,
  ContentLookup,
  ContentTypeName,
  Diagnostic,
  PackageId,
  ParseCtx,
  Severity,
  ValidateCtx,
} from "./types";
import { compareIds } from "./ids";

// Keep exhaustive: `DiagCode` is derived from it, so an unlisted code is a build error.
export const DIAG = {
  // reading the bytes
  "invalid-json": "The file could not be parsed as JSON.",
  "remote-rejected": "A remote package was rejected before parsing — size, origin or shape.",
  "missing-package": "A required package could not be found by any storage provider.",
  "package-cycle": "Packages require each other in a cycle.",

  // identity
  "bad-id": 'An identifier is not a well-formed "type:name" content id.',
  "unknown-type": "The id names a content type that no `defineType` registered.",
  "duplicate-id": "Two loaded assets claim the same id.",

  // the body
  "bad-field": "A field is present but has the wrong type, shape or range.",
  "missing-field": "A required field is absent.",
  "unsupported-schema": "The asset's schema revision is not one this build can read.",
  "too-deep": "A value is nested deeper than the structural limit allows.",
  "too-large": "A string, list or record is larger than the limit allows.",
  "too-many-diagnostics": "This asset produced more findings than the report will hold.",

  // the graph
  "missing-ref": "A reference points at an id nothing defines.",
  "wrong-ref-type": "A reference resolves to an asset of the wrong content type.",
  orphan: "Nothing references this asset and no system enumerates it.",

  // the extension points
  "unknown-test": "A condition names a test that no `defineTest` registered.",
  "unknown-action": "An action names a handler that no `defineAction` registered.",
  "unknown-factory": "Content selects an engine behaviour that no `defineFactory` registered.",

  // availability
  "never-available": "The availability condition can never pass with the content loaded.",

  // player-visible text
  "missing-text": "A required display string is absent, or names a missing string key.",
} as const;

export type DiagCode = keyof typeof DIAG;

export function explain(code: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(DIAG, code) ? DIAG[code as DiagCode] : undefined;
}

/** The only place the severity order is written down. */
const RANK: Readonly<Record<Severity, number>> = { info: 0, warn: 1, error: 2, fatal: 3 };

export function severityRank(s: Severity): number {
  return RANK[s];
}

export function worseOf(a: Severity, b: Severity): Severity {
  return RANK[a] >= RANK[b] ? a : b;
}

export function atLeast(s: Severity, min: Severity): boolean {
  return RANK[s] >= RANK[min];
}

// ONE line, so a report is greppable: severity code assetId field: message [source] -> fix
export function formatDiagnostic(d: Diagnostic): string {
  let line = `${d.severity} ${d.code}`;
  if (d.assetId) {
    line += ` ${d.assetId}`;
  } else if (d.pkg) {
    line += ` @${d.pkg}`;
  }
  if (d.field) {
    line += ` ${d.field}`;
  }
  line += `: ${d.message}`;
  if (d.related && d.related.length > 0) {
    line += ` (${d.related.join(", ")})`;
  }
  if (d.source) {
    line += ` [${d.source}]`;
  }
  if (d.fix) {
    line += ` -> ${d.fix}`;
  }
  return line;
}

export function formatDiagnostics(list: readonly Diagnostic[]): string {
  return list.map(formatDiagnostic).join("\n");
}

export interface SinkOptions {
  /** Hard ceiling: a bad remote pack can report one per field. */
  readonly limit?: number;
}

const DEFAULT_LIMIT = 2000;

export class DiagnosticSink {
  private readonly list: Diagnostic[] = [];
  private readonly seen = new Set<string>();
  private readonly limit: number;
  /** Dropped by the cap — reported once, counted for honesty. */
  private overflow = 0;
  private capped = false;

  constructor(opts: SinkOptions = {}) {
    this.limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
  }

  /** Findings held (after dedupe). */
  get size(): number {
    return this.list.length;
  }

  /** False when it was a duplicate or the cap was hit. */
  add(d: Diagnostic): boolean {
    const key = `${d.code}\u0000${d.assetId ?? ""}\u0000${d.field ?? ""}`;
    if (this.seen.has(key)) {
      return false;
    }
    if (this.list.length >= this.limit) {
      this.overflow++;
      if (!this.capped) {
        this.capped = true;
        this.list.push({
          severity: "warn",
          code: "too-many-diagnostics",
          message: `stopped after ${this.limit} findings`,
          fix: "fix the first ones and run again — they are usually one cause",
        });
      }
      return false;
    }
    this.seen.add(key);
    this.list.push(d);
    return true;
  }

  addAll(ds: Iterable<Diagnostic>): void {
    for (const d of ds) {
      this.add(d);
    }
  }

  worst(): Severity | undefined {
    let out: Severity | undefined;
    for (const d of this.list) {
      out = out === undefined ? d.severity : worseOf(out, d.severity);
    }
    return out;
  }

  /** One severity, or all when omitted. */
  count(severity?: Severity): number {
    if (severity === undefined) {
      return this.list.length;
    }
    let n = 0;
    for (const d of this.list) {
      if (d.severity === severity) n++;
    }
    return n;
  }

  /** True when anything at least this bad was reported. */
  has(severity: Severity): boolean {
    for (const d of this.list) {
      if (atLeast(d.severity, severity)) return true;
    }
    return false;
  }

  /** Worst first, every tie broken, so two runs are byte-identical. */
  sorted(): readonly Diagnostic[] {
    return [...this.list].sort(compareDiagnostics);
  }

  format(d: Diagnostic): string {
    return formatDiagnostic(d);
  }

  toText(): string {
    return formatDiagnostics(this.sorted());
  }

  /** Plain data only: a debug hook's answer must survive `structuredClone`. */
  toJSON(): {
    worst: Severity | null;
    counts: Record<Severity, number>;
    dropped: number;
    diagnostics: Diagnostic[];
  } {
    return {
      worst: this.worst() ?? null,
      counts: {
        info: this.count("info"),
        warn: this.count("warn"),
        error: this.count("error"),
        fatal: this.count("fatal"),
      },
      dropped: this.overflow,
      diagnostics: this.sorted().map((d) => ({ ...d })),
    };
  }

  clear(): void {
    this.list.length = 0;
    this.seen.clear();
    this.overflow = 0;
    this.capped = false;
  }

  // Bound reporters: the sink stamps the envelope (asset, source, package) so no
  // parser has to carry it and forget one.
  parseCtx(
    assetId: ContentId,
    source: string,
    extra: { readonly pkg?: PackageId; readonly assetType?: ContentTypeName } = {},
  ): ParseCtx {
    return {
      assetId,
      source,
      report: (d) => {
        this.add({ ...extra, ...d, assetId, source });
      },
    };
  }

  validateCtx(
    content: ContentLookup,
    defaults: {
      readonly assetId?: ContentId;
      readonly pkg?: PackageId;
      readonly source?: string;
      readonly assetType?: ContentTypeName;
    } = {},
  ): ValidateCtx {
    return {
      content,
      report: (d) => {
        this.add({ ...defaults, ...d, assetId: d.assetId ?? defaults.assetId });
      },
    };
  }
}

/** Exported so a caller merging two reports orders them the same way. */
export function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  const s = RANK[b.severity] - RANK[a.severity];
  if (s !== 0) {
    return s;
  }
  const ia = compareIds(a.assetId ?? "", b.assetId ?? "");
  if (ia !== 0) {
    return ia;
  }
  const fa = a.field ?? "";
  const fb = b.field ?? "";
  if (fa !== fb) {
    return fa < fb ? -1 : 1;
  }
  if (a.code !== b.code) {
    return a.code < b.code ? -1 : 1;
  }
  return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
}
