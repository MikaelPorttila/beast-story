/**
 * How content complains — the sink that collects findings and the one table of
 * codes it complains with (spec §17).
 *
 * THE SEVERITY SPLIT IS THE WHOLE DESIGN, and it is a statement about what the
 * RUNTIME can do rather than about how annoyed the author should be:
 *
 *   - `error` is content the runtime carries on WITHOUT. One dialogue line points
 *     at a quest nobody wrote; that interaction is broken and the other four
 *     hundred assets in the package are fine. The loader keeps the package, the
 *     asset gets a placeholder, and the player walks past a door that does not
 *     open instead of a black screen.
 *   - `fatal` is content it CANNOT carry on without. The core package will not
 *     parse; there is no world to stand in. This is the only class that throws,
 *     and it throws in exactly one function (`assertLoadable`, validate.ts).
 *
 * That split then reads differently in three environments (spec §17.3), which is
 * `ValidateOptions.level` in validate.ts and not a property of a diagnostic:
 * DEVELOPMENT continues through errors with placeholders, because a designer
 * mid-edit always has half-written content and a system that refuses to boot on
 * it is a system nobody uses; an automated CHECK fails on them; production
 * PACKAGING escalates them to fatal and refuses to emit a build. One finding,
 * three consequences — so nothing here decides tolerance, and every code below
 * means the same thing wherever it is raised.
 *
 * THE CODES ARE A CONTRACT. Tools match on them (`--code missing-ref`), probes
 * print them, and a CI job greps for them, so a code is renamed the way a
 * `ContentId` is renamed: as a migration, not as an edit. They are kebab-case
 * because they end up on a command line and in a URL query.
 *
 * DEDUPE IS ON (code, assetId, field) AND NOT ON THE MESSAGE. The same broken
 * reference is found by the load pass and again by the cross-asset pass, and the
 * two write different sentences about it; deduping on the sentence would print
 * both, which is how a report of forty real problems becomes a wall of a hundred
 * and twenty that nobody reads to the end. The message is for a human, the
 * triple is the identity.
 *
 * ORDER IS TOTAL, DELIBERATELY. `sorted()` breaks every tie — severity, then id
 * through `compareIds`, then field, then code, then message — because the first
 * thing anyone does with a diagnostic dump is diff two runs of it, and a Map's
 * insertion order is LOAD order, which changes the day a package is split in
 * two. See the same argument at `compareIds` in ids.ts.
 */

import type {
  ContentId,
  ContentLookup,
  ContentTypeName,
  Diagnostic,
  PackageId,
  ParseCtx,
  Severity,
  ValidateCtx,
} from './types';
import { compareIds } from './ids';

// ---------------------------------------------------------------------------
// The code table
// ---------------------------------------------------------------------------

/**
 * Every diagnostic code, with what it means in one line.
 *
 * Keep this exhaustive: a code that is raised but not listed here is a code no
 * tool can document, and `DiagCode` is what makes that a compile error rather
 * than a typo that ships.
 */
export const DIAG = {
  // --- reading the bytes ---------------------------------------------------
  /** A package or one of its files is not JSON at all. */
  'invalid-json': 'The file could not be parsed as JSON.',
  /** A remote package was refused by policy before it was parsed (spec §22). */
  'remote-rejected': 'A remote package was rejected before parsing — size, origin or shape.',
  /** A required package was offered by no provider. */
  'missing-package': 'A required package could not be found by any storage provider.',
  /** Packages require one another in a loop, so no load order exists. */
  'package-cycle': 'Packages require each other in a cycle.',

  // --- identity ------------------------------------------------------------
  /** A string in an id position is not `type:name` — see ids.ts for the grammar. */
  'bad-id': 'An identifier is not a well-formed "type:name" content id.',
  /** An id names a content type nothing registered. */
  'unknown-type': 'The id names a content type that no `defineType` registered.',
  /** Two loaded assets claim the same id. */
  'duplicate-id': 'Two loaded assets claim the same id.',

  // --- the body ------------------------------------------------------------
  /** A field is present and is the wrong shape, the wrong type or out of range. */
  'bad-field': 'A field is present but has the wrong type, shape or range.',
  /** A required field is absent. */
  'missing-field': 'A required field is absent.',
  /** The body was written against a schema revision this build cannot read. */
  'unsupported-schema': "The asset's schema revision is not one this build can read.",
  /** Structure nested deeper than the cap — untrusted JSON, spec §22. */
  'too-deep': 'A value is nested deeper than the structural limit allows.',
  /** A string, list or record exceeded its size cap — untrusted JSON, spec §22. */
  'too-large': 'A string, list or record is larger than the limit allows.',
  /** One asset produced so many findings that the rest were dropped. */
  'too-many-diagnostics': 'This asset produced more findings than the report will hold.',

  // --- the graph -----------------------------------------------------------
  /** A reference names an id that no loaded asset defines. */
  'missing-ref': 'A reference points at an id nothing defines.',
  /** A reference resolves, but to an asset of a type the field does not want. */
  'wrong-ref-type': 'A reference resolves to an asset of the wrong content type.',
  /** Nothing points at this asset and no system enumerates its type. */
  orphan: 'Nothing references this asset and no system enumerates it.',

  // --- the extension points ------------------------------------------------
  /** A condition names a test nothing registered — evaluates false (types.ts). */
  'unknown-test': 'A condition names a test that no `defineTest` registered.',
  /** An action names a handler nothing registered — skipped at run time. */
  'unknown-action': 'An action names a handler that no `defineAction` registered.',
  /** Content selects an engine behaviour by a name nothing registered. */
  'unknown-factory': 'Content selects an engine behaviour that no `defineFactory` registered.',

  // --- availability --------------------------------------------------------
  /** The `when` can never pass, so the asset can never be reached. */
  'never-available': 'The availability condition can never pass with the content loaded.',

  // --- player-visible text -------------------------------------------------
  /** A display string is required and absent, or names a key the table lacks. */
  'missing-text': 'A required display string is absent, or names a missing string key.',
} as const;

/** Every code in `DIAG`. Typing `Diagnostic.code` off this makes a typo a build error. */
export type DiagCode = keyof typeof DIAG;

/** What a code means, for `--explain` in a tool and for the formatted line. */
export function explain(code: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(DIAG, code)
    ? DIAG[code as DiagCode]
    : undefined;
}

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

const RANK: Readonly<Record<Severity, number>> = { info: 0, warn: 1, error: 2, fatal: 3 };

/** 0 (info) to 3 (fatal). The only place the order is written down. */
export function severityRank(s: Severity): number {
  return RANK[s];
}

/** The worse of two severities. */
export function worseOf(a: Severity, b: Severity): Severity {
  return RANK[a] >= RANK[b] ? a : b;
}

/** True when `s` is at least as bad as `min`. */
export function atLeast(s: Severity, min: Severity): boolean {
  return RANK[s] >= RANK[min];
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * ONE readable line, naming the source and the fix.
 *
 * One line because these are read a screenful at a time, and because a
 * multi-line diagnostic cannot be grepped — the question a developer actually
 * asks is "which file do I open", and every field beyond the message exists to
 * answer it without a search (see `Diagnostic` in types.ts).
 *
 *   error missing-ref npc:gain data.dialogue[0].next: nothing defines
 *     "dialogue:gain/hello" [bundled:core#3] -> add it, or drop the reference
 */
export function formatDiagnostic(d: Diagnostic): string {
  let line = `${d.severity} ${d.code}`;
  if (d.assetId) line += ` ${d.assetId}`;
  else if (d.pkg) line += ` @${d.pkg}`;
  if (d.field) line += ` ${d.field}`;
  line += `: ${d.message}`;
  if (d.related && d.related.length > 0) line += ` (${d.related.join(', ')})`;
  // The source is where the bytes are. It is last because it is the longest
  // field and the one an eye skips until it is needed.
  if (d.source) line += ` [${d.source}]`;
  if (d.fix) line += ` -> ${d.fix}`;
  return line;
}

/** Several of them, worst first, one per line. */
export function formatDiagnostics(list: readonly Diagnostic[]): string {
  return list.map(formatDiagnostic).join('\n');
}

// ---------------------------------------------------------------------------
// The sink
// ---------------------------------------------------------------------------

export interface SinkOptions {
  /**
   * Hard ceiling on stored findings. A hostile or simply enormous remote package
   * can generate one per field; the report is for a human, so past this point
   * the sink keeps a single `too-many-diagnostics` and drops the rest rather
   * than holding a hundred megabytes of complaints about one bad file.
   */
  readonly limit?: number;
}

const DEFAULT_LIMIT = 2000;

/**
 * Collects diagnostics, deduped and orderable.
 *
 * Deliberately not an EventEmitter and deliberately not throwing: everything in
 * this system reports, and exactly one function decides that a report is bad
 * enough to stop for (`assertLoadable` in validate.ts).
 */
export class DiagnosticSink {
  private readonly list: Diagnostic[] = [];
  private readonly seen = new Set<string>();
  private readonly limit: number;
  /** How many were dropped by the cap — reported once, counted for honesty. */
  private overflow = 0;
  private capped = false;

  constructor(opts: SinkOptions = {}) {
    this.limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
  }

  /** Findings held (after dedupe). */
  get size(): number {
    return this.list.length;
  }

  /**
   * Record one. Returns false when it was a duplicate or the cap was hit —
   * a caller that wants to know whether it said something new can ask, and
   * every caller that does not can ignore it.
   */
  add(d: Diagnostic): boolean {
    const key = `${d.code}\u0000${d.assetId ?? ''}\u0000${d.field ?? ''}`;
    if (this.seen.has(key)) return false;
    if (this.list.length >= this.limit) {
      this.overflow++;
      if (!this.capped) {
        this.capped = true;
        this.list.push({
          severity: 'warn',
          code: 'too-many-diagnostics',
          message: `stopped after ${this.limit} findings`,
          fix: 'fix the first ones and run again — they are usually one cause',
        });
      }
      return false;
    }
    this.seen.add(key);
    this.list.push(d);
    return true;
  }

  /** Record several. */
  addAll(ds: Iterable<Diagnostic>): void {
    for (const d of ds) this.add(d);
  }

  /** The worst severity seen, or undefined when nothing was reported. */
  worst(): Severity | undefined {
    let out: Severity | undefined;
    for (const d of this.list) out = out === undefined ? d.severity : worseOf(out, d.severity);
    return out;
  }

  /** How many of one severity, or of all when omitted. */
  count(severity?: Severity): number {
    if (severity === undefined) return this.list.length;
    let n = 0;
    for (const d of this.list) if (d.severity === severity) n++;
    return n;
  }

  /** True when anything at least this bad was reported. */
  has(severity: Severity): boolean {
    for (const d of this.list) if (atLeast(d.severity, severity)) return true;
    return false;
  }

  /**
   * Worst first, then by asset id, then by field, code and message.
   *
   * Every tie is broken so that two runs of a probe over the same content
   * produce byte-identical output — see the header.
   */
  sorted(): readonly Diagnostic[] {
    return [...this.list].sort(compareDiagnostics);
  }

  /** One line each, worst first. */
  format(d: Diagnostic): string {
    return formatDiagnostic(d);
  }

  /** The whole report as text, worst first. */
  toText(): string {
    return formatDiagnostics(this.sorted());
  }

  /**
   * For `__dbgContent()` and for a tool's `--json`.
   *
   * Plain data only — no class instances and no `undefined` values — because a
   * debug hook's answer has to survive `structuredClone` on its way out of the
   * page (see `tools/q.mjs` in AGENTS.md).
   */
  toJSON(): {
    worst: Severity | null;
    counts: Record<Severity, number>;
    dropped: number;
    diagnostics: Diagnostic[];
  } {
    return {
      worst: this.worst() ?? null,
      counts: {
        info: this.count('info'),
        warn: this.count('warn'),
        error: this.count('error'),
        fatal: this.count('fatal'),
      },
      dropped: this.overflow,
      diagnostics: this.sorted().map((d) => ({ ...d })),
    };
  }

  /** Drop everything. For a reload, and for a test that reuses one sink. */
  clear(): void {
    this.list.length = 0;
    this.seen.clear();
    this.overflow = 0;
    this.capped = false;
  }

  // -------------------------------------------------------------------------
  // Bound reporters
  // -------------------------------------------------------------------------

  /**
   * A `ParseCtx` that reports into this sink.
   *
   * Here rather than in the loader because the ENVELOPE fields a parser must not
   * have to repeat — the asset id, where the bytes came from, which package
   * delivered them — are the same three every time, and a parser that had to
   * carry them would eventually forget one and produce a diagnostic naming no
   * file.
   */
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

  /** A `ValidateCtx` that reports into this sink, defaulting the asset it is about. */
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

/** The total order `sorted()` uses. Exported so a caller merging two reports agrees. */
export function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  const s = RANK[b.severity] - RANK[a.severity];
  if (s !== 0) return s;
  const ia = compareIds(a.assetId ?? '', b.assetId ?? '');
  if (ia !== 0) return ia;
  const fa = a.field ?? '';
  const fb = b.field ?? '';
  if (fa !== fb) return fa < fb ? -1 : 1;
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
}
