// The one provider whose answers are UNTRUSTED, so every measurement is taken BEFORE
// the value is handed on: byte cap while STREAMING (Content-Length is the sender's
// claim), depth cap on an EXPLICIT stack, content-type (an HTML login page is a 200),
// and ids validated before they touch a URL.
// Nothing throws — a failure is null plus a reason on `lastError`.

import type { PackageId, StorageProvider } from '../types';
import { isPackageId } from '../ids';

const FILE_RE = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*\.json$/;

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_DEPTH = 64;

const DEFAULT_TIMEOUT_MS = 15_000;

export interface HttpProviderOptions {
  /** A DIRECTORY: a trailing slash is added, or `new URL` resolves against the host root. */
  readonly baseUrl: string;
  /** Authored: HTTP has no listing. Absent means "unknown", not "none". */
  readonly packages?: readonly PackageId[];
  /** Below the bundled provider: what shipped beats what is fetched. */
  readonly priority?: number;
  readonly name?: string;
  readonly maxBytes?: number;
  readonly maxDepth?: number;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly credentials?: RequestCredentials;
}

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

// Bails at `max`. No cycle set: `JSON.parse` output is a tree.
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

// Null when the cap is hit. Streaming `TextDecoder`, so a split character counts once.
async function readCapped(res: Response, max: number): Promise<string | null> {
  const body = res.body;
  if (body === null) {
    // No stream to meter (a mocked fetch): weaker, so still measured.
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
    // Matters on the cap path: an un-cancelled reader keeps paying for a refused body.
    await reader.cancel().catch(() => undefined);
  }
  out += decoder.decode();
  return out;
}

// Not writable: a PUT back to a content host is a different feature with its own
// threat model, and half of one would make `writable: true` a lie.
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
  /** Successful reads only: a null may be transient. */
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
    // `omit` by default: content is public, and a session cookie must not reach a CDN.
    this.credentials = opts.credentials ?? 'omit';
  }

  get lastError(): HttpError | null {
    return this.error;
  }

  async list(): Promise<readonly PackageId[]> {
    return this.known.filter(isPackageId);
  }

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

  // Both halves pass a grammar first: `new URL` is not a security boundary.
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
    // Catches an odd base, not a hostile `rel`.
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
        // A body deep enough to overflow the parser throws RangeError here, before
        // the depth check — one catch, one code.
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
