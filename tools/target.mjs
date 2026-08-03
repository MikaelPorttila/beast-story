// Where the tools point, and how they share one browser.
//
// TWO THINGS USED TO BE COPIED BY HAND INTO EVERY TOOL IN THIS DIRECTORY, and
// both of them were a per-run cost paid by whoever was driving:
//
//   * the PORT. `http://localhost:5187` was written out in 22 files, so a
//     worktree serving 5195 could only run a probe by making a throwaway copy
//     of it with sed (see AGENTS.md). A copy is a fork: it is edited, it is
//     forgotten, and `_tmp-*.mjs` is not gitignored. `BASE` below resolves the
//     port instead — BS_PORT, then this worktree's .claude/launch.json, then
//     5187 — so the DEFAULT is exactly the old hardcoded string and nothing
//     outside a worktree behaves differently.
//   * the BROWSER. Every probe launched its own, and a launch is ~1 s of
//     nothing happening. `launchBrowser` (browser.mjs) now joins an already
//     running one when BS_BROWSER_WS names it, which is what tools/probe.mjs
//     sets while it runs a batch. Isolation is unchanged: each probe still
//     builds its own pages and contexts, and localStorage does not cross
//     between them.
//
// Neither is a behaviour change for a tool run on its own from the main
// checkout, which is the point — the contract stays "bun tools/test-x.mjs".
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function launchJsonPort() {
  try {
    const cfg = JSON.parse(readFileSync(join(ROOT, '.claude', 'launch.json'), 'utf8'));
    const port = cfg?.configurations?.find((c) => Number.isFinite(c?.port))?.port;
    return Number.isFinite(port) ? port : null;
  } catch {
    return null; // no launch.json (main checkout) — fall through to the pin
  }
}

const envPort = Number(process.env.BS_PORT);
export const PORT = Number.isFinite(envPort) && envPort > 0
  ? envPort
  : launchJsonPort() ?? 5187;

export const BASE = `http://localhost:${PORT}`;

/** Game entry. Query may start with `?` or not; `menu=0` is the caller's job. */
export const gameUrl = (query = '') => `${BASE}/${query.replace(/^\/?/, '')}`;
