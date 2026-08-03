/**
 * CONTENT FETCHED FROM SOMEWHERE ELSE (spec §13.1) — and the one provider whose
 * answers are UNTRUSTED (spec §22).
 *
 * Everything the bundled provider serves was in the repository when the build
 * was made; everything this one serves arrived over a wire from a host that may
 * be compromised, misconfigured, or simply not the host we meant. So the rule
 * here is different in kind from the rule everywhere else in this codebase: a
 * response is hostile input until it has been measured, and every measurement is
 * taken BEFORE the value is handed on, not after something downstream has
 * already walked it.
 *
 * FOUR DEFENCES, each against a specific failure rather than a general worry:
 *
 *   - A BYTE CAP, enforced while STREAMING. `Content-Length` is a claim by the
 *     sender and may be absent, wrong, or a lie; a chunked response has none at
 *     all. Reading `response.text()` and checking the length afterwards means
 *     the whole of a hostile body is already in memory by the time we object,
 *     which is the denial of service rather than the defence against it. The
 *     header is checked first because it is free, and then the stream is counted
 *     and cut.
 *   - A NESTING-DEPTH CAP. `JSON.parse` is happy to build a hundred-thousand-
 *     deep array; every recursive walk downstream of it — the parser, the ref
 *     extractor, the deep freeze, `JSON.stringify` in a save — then overflows
 *     the stack, and a stack overflow in the frame loop is a crashed game rather
 *     than a rejected package. Measured with an EXPLICIT stack, because a
 *     recursive depth check is the same overflow it exists to prevent.
 *   - A CONTENT-TYPE CHECK. An HTML error page, a login redirect and a captive
 *     portal all arrive with status 200; without this, "the wifi wants a
 *     password" reads as "this package is corrupt".
 *   - A VALIDATED PACKAGE ID. The id goes through `isPackageId` before it is
 *     ever concatenated into a URL, so `..%2f..%2fadmin` is rejected at the
 *     boundary rather than normalised somewhere in the middle. Same for `file`.
 *
 * ABSENCE IS NOT AN ERROR, so nothing here throws. A network failure returns
 * null and the chain falls through to the next provider — that is the whole
 * mechanism by which a remote pack is optional. The REASON is kept on
 * `lastError` so a diagnostic can say "404" instead of "not found", which is the
 * difference between a missing feature and a broken deploy.
 */

import type { PackageId, StorageProvider } from '../types';
import { isPackageId } from '../ids';

/** Same grammar as the bundled provider's sibling files: no dots, so no `..`. */
const FILE_RE = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*\.json$/;

/**
 * 4 MiB. A content package is text describing what exists — the largest thing a
 * package can honestly be is a zone's worth of towns, NPCs and quests, which is
 * kilobytes. This is set two orders of magnitude above that so it can only ever
 * be hit by something that is not a content package.
 */
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * 64 levels. The deepest legitimate shape in this system is a nested `Condition`
 * tree, and one an author can read is a handful deep; 64 leaves room for a
 * generated one and still stops the stack-overflow class outright.
 */
const DEFAULT_MAX_DEPTH = 64;

/** 15 s. Long enough for a slow phone on a cold cache, short enough to give up. */
const DEFAULT_TIMEOUT_MS = 15_000;

export interface HttpProviderOptions {
  /**
   * Where packages live. Treated as a DIRECTORY — a trailing slash is added when
   * it is missing, because `new URL('core.json', 'https://x/content')` resolves
   * against `https://x/` and quietly fetches the wrong thing.
   */
  readonly baseUrl: string;
  /**
   * Package ids this host is known to serve. HTTP has no directory listing, so
   * enumeration is AUTHORED rather than discovered — `list()` cannot invent an
   * answer, and returning an empty one is honest. Absent means "unknown", not
   * "none": `read` still works for an id the caller already knows.
   */
  readonly packages?: readonly PackageId[];
  /** Below the bundled provider: what shipped beats what is fetched (spec §13.2). */
  readonly priority?: number;
  readonly name?: string;
  readonly maxBytes?: number;
  readonly maxDepth?: number;
  readonly timeoutMs?: number;
  /** Injectable for tests. Defaults to the global. */
  readonly fetch?: typeof fetch;
  /** Passed through to every request; `'omit'` by default — see the note below. */
  readonly credentials?: RequestCredentials;
}

/** Why the last read returned null. Never thrown; read it for a diagnostic. */
export interface HttpError {
  readonly url: string;
  /** Machine-stable — `status`, `content-type`, `too-large`, `too-deep`, `bad-json`, `network`, `bad-id`. */
  readonly code: string;
  readonly message: string;
}

function isJsonType(header: string | null): boolean {
  if (header === null) return false;
  const type = header.split(';', 1)[0].trim().toLowerCase();
  return type === 'application/json' || type === 'text/json' || type.endsWith('+json');
}

/**
 * The nesting depth of a parsed JSON value, measured iteratively.
 *
 * Stops counting the moment it passes `max` — the caller only ever asks whether
 * the value is too deep, and a hostile body is exactly the one where finishing
 * the walk is expensive. No cycle set is needed: this only ever runs on the
 * output of `JSON.parse`, which is a tree by construction.
 */
function exceedsDepth(root: unknown, max: number): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 1 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (value === null || typeof value !== 'object') continue;
    if (depth > max) return true;
    if (Array.isArray(value)) {
      for (const child of value) stack.push({ value: child, depth: depth + 1 });
    } else {
      for (const child of Object.values(value)) stack.push({ value: child, depth: depth + 1 });
    }
  }
  return false;
}

/**
 * Read a response body as text, giving up the moment it passes `max` bytes.
 *
 * Returns null when the cap is hit, so the caller can name that specific
 * failure. `TextDecoder` in streaming mode is what makes the count exact across
 * a multi-byte character split over two chunks.
 */
async function readCapped(res: Response, max: number): Promise<string | null> {
  const body = res.body;
  if (body === null) {
    // No stream to meter (a mocked fetch, or a browser that gave us none).
    // Falling back to text() is a weaker guarantee, so it is still measured.
    const text = await res.text();
    return text.length > max ? null : text;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      bytes += value.byteLength;
      if (bytes > max) return null;
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    // Releasing matters on the cap path: the connection is still open and the
    // sender is still sending, so an un-cancelled reader keeps paying for a body
    // we have already refused.
    await reader.cancel().catch(() => undefined);
  }
  out += decoder.decode();
  return out;
}

/**
 * Fetches content packages over HTTP.
 *
 * Not writable. A `PUT` back to a content host is a different feature with a
 * different threat model (authentication, conflict, audit) and inventing half of
 * it here would make `writable: true` a promise this class cannot keep.
 */
export class HttpProvider implements StorageProvider {
  readonly name: string;
  readonly priority: number;
  readonly writable = false;

  private readonly base: string;
  private readonly known: readonly PackageId[];
  private readonly maxBytes: number;
  private readonly maxDepth: number;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;
  private readonly credentials: RequestCredentials;
  /** url -> value. Only SUCCESSFUL reads; a null is re-asked, since it may be transient. */
  private readonly cache = new Map<string, unknown>();
  private error: HttpError | null = null;

  constructor(opts: HttpProviderOptions) {
    this.base = opts.baseUrl.endsWith('/') ? opts.baseUrl : `${opts.baseUrl}/`;
    this.name = opts.name ?? `http(${this.base})`;
    this.priority = opts.priority ?? 10;
    this.known = opts.packages ?? [];
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
    // `omit` by default: content is public data, and sending a session cookie to
    // a third-party content host is how a CDN ends up holding credentials it was
    // never meant to see. A deployment that genuinely needs auth says so.
    this.credentials = opts.credentials ?? 'omit';
  }

  /** Why the last read returned null, or null when the last read succeeded. */
  get lastError(): HttpError | null {
    return this.error;
  }

  async list(): Promise<readonly PackageId[]> {
    return this.known.filter(isPackageId);
  }

  /** Drop every cached body. For an editor's reload, and for tests. */
  clearCache(): void {
    this.cache.clear();
  }

  async read(pkg: PackageId, file?: string): Promise<unknown | null> {
    const url = this.urlFor(pkg, file);
    if (url === null) {
      this.error = {
        url: this.base,
        code: 'bad-id',
        message: `refused package "${String(pkg)}"${file === undefined ? '' : ` file "${String(file)}"`}`,
      };
      return null;
    }

    const cached = this.cache.get(url);
    if (cached !== undefined) {
      this.error = null;
      return cached;
    }

    const value = await this.fetchJson(url);
    if (value !== null) this.cache.set(url, value);
    return value;
  }

  /**
   * Build the URL, or null when the caller's names are not ones we will put in
   * one. `new URL(relative, base)` does the joining, but only AFTER both halves
   * have passed a grammar that admits no `.`, `/`, `\` or escape — the relative
   * resolver is not a security boundary and was never meant to be one.
   */
  private urlFor(pkg: PackageId, file?: string): string | null {
    if (!isPackageId(pkg)) return null;
    const rel = file === undefined ? `${pkg}.json` : file;
    if (file !== undefined && !FILE_RE.test(file)) return null;
    let url: URL;
    try {
      url = new URL(rel, this.base);
    } catch {
      return null;
    }
    // Belt and braces: even a validated relative part must not have escaped the
    // base. This catches a base that was itself odd rather than a hostile `rel`.
    if (!url.href.startsWith(this.base)) return null;
    return url.href;
  }

  private async fetchJson(url: string): Promise<unknown | null> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.doFetch(url, {
        credentials: this.credentials,
        signal: ctl.signal,
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        this.error = { url, code: 'status', message: `HTTP ${res.status} ${res.statusText}` };
        return null;
      }
      if (!isJsonType(res.headers.get('content-type'))) {
        this.error = {
          url,
          code: 'content-type',
          message: `expected JSON, got "${res.headers.get('content-type') ?? 'nothing'}"`,
        };
        return null;
      }
      const claimed = Number(res.headers.get('content-length'));
      if (Number.isFinite(claimed) && claimed > this.maxBytes) {
        this.error = {
          url,
          code: 'too-large',
          message: `declared ${claimed} bytes, cap is ${this.maxBytes}`,
        };
        return null;
      }
      const text = await readCapped(res, this.maxBytes);
      if (text === null) {
        this.error = { url, code: 'too-large', message: `body exceeded ${this.maxBytes} bytes` };
        return null;
      }
      let value: unknown;
      try {
        // A body deep enough to overflow the parser itself throws RangeError
        // here rather than reaching the depth check — which is why this catch
        // covers both and reports one code.
        value = JSON.parse(text);
      } catch (e) {
        this.error = { url, code: 'bad-json', message: e instanceof Error ? e.message : 'unparseable' };
        return null;
      }
      if (exceedsDepth(value, this.maxDepth)) {
        this.error = { url, code: 'too-deep', message: `nested deeper than ${this.maxDepth}` };
        return null;
      }
      this.error = null;
      return value;
    } catch (e) {
      const aborted = ctl.signal.aborted;
      this.error = {
        url,
        code: 'network',
        message: aborted
          ? `timed out after ${this.timeoutMs} ms`
          : e instanceof Error
            ? e.message
            : 'request failed',
      };
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
