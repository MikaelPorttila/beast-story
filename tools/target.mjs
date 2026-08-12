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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function launchJsonPort() {
  try {
    const cfg = JSON.parse(readFileSync(join(ROOT, ".claude", "launch.json"), "utf8"));
    const port = cfg?.configurations?.find((c) => Number.isFinite(c?.port))?.port;
    return Number.isFinite(port) ? port : null;
  } catch {
    return null; // no launch.json (main checkout) — fall through to the pin
  }
}

const envPort = Number(process.env.BS_PORT);
export const PORT = Number.isFinite(envPort) && envPort > 0 ? envPort : (launchJsonPort() ?? 5187);

export const BASE = `http://localhost:${PORT}`;

/** Game entry. Query may start with `?` or not; `menu=0` is the caller's job. */
export const gameUrl = (query = "") => `${BASE}/${query.replace(/^\/?/, "")}`;

/**
 * THE FLAG A PROBE THAT NEVER LOOKS AT A RENDERED FRAME SHOULD CARRY, and the
 * measurement that says so. Measured on the dev server, headless Brave on
 * hardware GL, time from `goto` to `__dbgBoot().playing`:
 *
 *   ?menu=0&fs=0               20.5 s
 *   ?menu=0&fs=0&warmup=0       1.4 s
 *
 * The world is not the cost — `createWorld` is ~0.6 s of that. The shader
 * warm-up sweep is 93% of it (see warmUpSteps in src/main.ts and the STAGES
 * note in src/ui/loading.ts), and on the `menu=0` path it runs SYNCHRONOUSLY
 * before the canvas is inserted, so a probe blocks the whole 20 s on
 * `waitForSelector('canvas')` whether it wanted a warm frame or not.
 *
 * WHAT IT SAVES IS ONE SWEEP PER RUN, NOT ONE PER LOAD, and the difference is
 * worth knowing before anybody predicts a number off a page count: Chromium
 * caches linked programs across pages in the same browser, so the FIRST load of
 * a run pays ~19 s and the rest pay a fraction of it. Measured end to end,
 * before against after:
 *
 *   about       36.1 s -> 18.6 s     crosshair    38 s -> 19 s
 *   textsize      63 s -> 40 s       viewport     42 s -> 22 s
 *   settings      47 s -> 29 s       cursor       32 s -> 13 s
 *   f2            27 s -> 11 s       content      23 s ->  5 s
 *
 * — eight probes, 308 s to 157 s, and the same verdicts. Note textsize: four
 * `menu=0` pages and it still saves one sweep's worth, which is the cache.
 *
 * WHO MUST NOT USE IT. The sweep exists to pay every shader link up front, so
 * the first seconds of play have no link stalls in them. Any probe that
 * measures a frame — draw calls, CPU cost, distance travelled under a held key,
 * a per-frame delta — keeps the sweep, because a stall inside its sample is
 * indistinguishable from the regression it is looking for. That is gfx,
 * shadowcache, streaming-stutter, sway, aim-assist, perf-baseline and every
 * probe on the suite roster.
 *
 * `grep -rn NO_WARMUP tools/` lists everything that has opted out, which is the
 * point of a named constant rather than four more characters in a URL.
 */
export const NO_WARMUP = "warmup=0";
