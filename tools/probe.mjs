// Run several probes as one command, and answer in one screen.
//
//   bun tools/probe.mjs road gfx npc          # three probes, serially
//   bun tools/probe.mjs all --jobs 3          # everything, three at a time
//   bun tools/probe.mjs road --json           # machine-readable summary
//
// This is a RUNNER, not a test framework: it spawns the same
// `bun tools/test-x.mjs` a person would, so a probe behaves identically inside
// a batch and on its own. What it adds is the three things that made running a
// set of them expensive:
//
//   * ONE BROWSER for the batch (BS_BROWSER_WS, see browser.mjs). Measured at
//     288 ms a launch, which is the SMALL half of the saving and worth stating
//     plainly — a probe's real cost is the game booting inside it (~17 s of
//     world build and shader link, `__dbgBoot().totalMs`), and no runner can
//     share that between two probes that each need a fresh world.
//   * CONCURRENCY, which is the large half. Boots overlap.
//   * ONE SUMMARY. Every probe's stdout goes to a log file; what lands on the
//     terminal is a line each, and the tail of whatever failed.
//
// TIMING-SENSITIVE PROBES RUN ALONE. Half the assertions in this directory are
// about frames — a look-rate that must match across fps caps, a hero who must
// travel a measured distance under a held key — and three games sharing one GPU
// do not produce the frame rate one game does. Those are listed in SOLO below
// and are never run beside anything, whatever --jobs says. A probe that is
// wrong about which list it belongs in is a flaky test, so the default for a
// new one is SOLO.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./browser.mjs";
import { CONVERTED } from "./suite/roster.mjs";
import { PORT } from "./target.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Probes that assert on frame rate, elapsed motion or CPU cost. Never batched.
// Four of these are here because a batch was RUN and the output moved, which
// is the only evidence worth putting a name on either list for:
//   sway        slots 3 -> 4, areaRadius 11.94 -> 18.56 (more movers per frame)
//   aim-assist  widestSelected 66.29 deg -> 0.18, narrowestRefused null
//   f2          the overlay had not been built yet 2.5 s after the canvas, so
//               every reading came back null — AND THE PROBE STILL EXITED 0,
//               because it asserts nothing. See the note on silent probes below.
//   content     one key press in forty-odd assertions, and a batched page is a
//               background tab with no rAF to consume it. See its entry below.
//
// `perf-baseline` USED TO BE THE FIRST NAME ON THIS LIST AND IT IS NOT A PROBE.
// It sat here for as long as this roster has existed and it never ran once:
// every entry is spawned as `tools/test-<name>.mjs` and the file is
// `tools/perf-baseline.mjs`, so `probe.mjs all` reported
// `Module not found "tools/test-perf-baseline.mjs"` on every run anybody has
// ever done. A suite that is permanently one-red teaches everyone to read a
// failure count instead of a pass, which is the whole cost of the bug — the
// missing coverage was never there to lose.
//
// It is REMOVED rather than renamed or special-cased, because fixing the path
// would not have made it green either. `perf-baseline` with no
// `.perf-baseline.json` exits 2 and tells you to record one, and that file is
// per-machine and gitignored on purpose (frame cost is a property of the
// hardware — see the header of tools/perf-baseline.mjs). So on any machine that
// has not run the manual `record` step first, which is every fresh checkout, a
// path-corrected entry would still fail. It is a COMPARISON TOOL with a setup
// step, not a pass/fail assertion, and it belongs where AGENTS.md already puts
// it: run it yourself, by name.
//
//   bun tools/perf-baseline.mjs record     once per machine
//   bun tools/perf-baseline.mjs            compare the working tree
//
const SOLO = new Set([
  "gamepad", // section 7 compares look rate across fps caps
  "touch", // sums yaw deltas over a stick hold
  "beastanim", // per-frame rotation deltas
  "dive", // ascent speed in units/second
  // Teleports the hero to a wild beast, throws a projectile that has to FLY to
  // it, and measures whether a wild body travelled over a second. The last of
  // those is elapsed motion; the middle one needs frames to happen in at all.
  "taming",
  // Drives four different bodies at a coastline and measures how far each got,
  // plus a mounted top speed on either side of a waterline. Every one of those
  // is elapsed motion, and it mounts through __dbgRide, which drives state.
  "deepwater",
  "menu", // menuShownAtMs, and a held W measured against another hold
  "keybinds", // one section runs UNCAPPED on purpose
  "pause", // held-W distances either side of the menu
  // Held-W distances either side of the journal, and it stages a quest whose
  // `timeOfDay` pins the world clock — see the header of tools/test-journal.mjs
  // for why that keeps it off a shared page as well as out of PARALLEL.
  "journal",
  // The campaign walked end to end (issue #143): it presses E to talk, throws
  // orbs at a staged beast and reads the counters that follow. Every one of
  // those is a frame-loop edge, so a background tab consumes none of them.
  "story-land",
  // Drives the hero 150 units at a time and counts what SPAWNED around him, so a
  // shared page would be measuring another probe's teleports (issue #204).
  "spawn-tables",
  // Kills the hero to see where he wakes up, which no shared page survives.
  "waypoints",
  // Crosses zones for real, which tears down a world and builds another: nothing
  // may share a page with it, and it is the one probe that measures a crossing's
  // wall clock (issue #211).
  "gateway",
  // Presses E to take a quest and throws orbs to finish it, then reads what the
  // frame drew — every one of those needs a frame loop the tab is not given in
  // the background.
  "quest-marks",
  "structures", // walk distances into colliders
  "npc", // walks to a talk range
  "road", // drives the hero along a carriageway
  "gfx", // draw-call counts under a live frame cap
  // Opens the F3 panel with a key press and clicks one of its rows — a key edge
  // is consumed by the frame loop, and a batched page is a background tab with
  // no frames at all. See the note under PARALLEL.
  "hair",
  "sway", // measured: mover count and area radius move under load
  "aim-assist", // measured: selection angles collapse under load
  "f2", // measured: reads null under load, and asserts nothing
  "settings", // measured: drained cue count 2 -> 1, lastKind changed
  // The only probe that boots WITHOUT `nostore=1`, so it is the only one whose
  // pages write to IndexedDB. It also replaces the running session repeatedly —
  // every case loads a character over the one before it — which is the shape
  // the shared roster explicitly excludes. SOLO is the default anyway.
  "saves",
  "nature", // rebuilds ~90 chunks per section and counts their vertices
  "view-distance", // teleports the hero and waits for the far clipmap to recenter
  // Teleports to every settlement in turn and waits for the streaming ring to
  // fill at each, then walks a few hundred thousand streamed vertices.
  "foliage-clip",
  "streaming-stutter", // forces a fresh view disk and measures per-frame world CPU
  // Its fade assertions are a wall-clock envelope read a fixed time after a
  // track starts, and it walks the staged boot to New Game — both of the things
  // that go wrong when three games share a GPU. SOLO is also the default.
  "music",
  "textsize", // stages the HUD through __dbgStageHud after a fixed wait
  // Nothing in it measures a frame, a distance or a CPU figure — it reads the
  // content registry, the town/npc/enemy tables and the dev console — and it is
  // gated on `__dbgBoot().playing` rather than on a settle, so on the face of it
  // it belongs above. It is here because the A/B was RUN and named the reason:
  // ONE KEY PRESS. Its identity section talks to Gain, and a key edge is
  // consumed by the frame loop. A page that is not the shared browser's FRONT
  // TAB reports `visibilityState: 'hidden'` and is given no requestAnimationFrame
  // at all — measured with two pages in one browser, the background one held W
  // for 1.2 s and travelled 0.00 units against the front one's 6.39, while its
  // performance clock advanced normally (1507 ms against 1512) and every
  // read-only hook went on answering. So batched it failed on exactly one line
  // ("the sentence Gain actually says: got null") with all forty-odd other
  // assertions green, which is the most misleading failure a batch can produce.
  // `bringToFront()` is not the fix: four probes cannot all be the front tab.
  // Drop the talk drive and it may move up.
  "content",
  // Drives the hero with a pad button, holds him in the air on a 16 ms interval
  // and asserts on an enemy's hp either side of a swing. Every one of those is a
  // frame the loop has to run.
  "proximity",
  // Was on NEITHER list, so `all` skipped the flying town entirely — which is
  // how issue #80 (fly straight through the island, walk through its wood)
  // reached a release with a probe for carriers already in the tree. It belongs
  // here on its own merits now: section 7 mounts a flyer through __dbgRide and
  // holds Space for twelve seconds, measuring where the climb stopped.
  "carrier",
  // Measures MOTION — two frames half a second apart over the plume, against a
  // control patch of the same backdrop — which is the one thing a background tab
  // cannot deliver: no requestAnimationFrame means no animation and the delta
  // reads 0 for the right reason and the wrong result. It also takes eleven page
  // loads, half of them screenshots.
  "waterfall",
  "daynight", // waits on a live clock and measures the 0.5 s light cadence
  // Reads two pages and drives nothing, so on the face of it it belongs below —
  // but one of them is the GAME booted to `playing`, and SOLO is the default
  // until an A/B says otherwise. See the note under PARALLEL.
  "fence",
  // Holds WASD with the F3 search box focused and measures that the hero did
  // NOT move, against a control hold that says he otherwise would. Both halves
  // are held keys the frame loop has to consume — see the note above.
  "spawn",
  // Presses the attack button and counts what reaches the sky. It drives the
  // hero, which is the whole of the rule above — and its clock is
  // `__dbgAdvance`, so a background tab with no rAF steps no slices at all.
  "bow",
  // Stages a fight between a stationary hero and one wild beast and measures
  // the path the beast walks — distances and swept bearing over 140 simulated
  // samples. Elapsed motion, and it drives state (spawn, two teleports).
  "beastaggro",
  // Advances an enemy-free party past the support skill timer, then stages a
  // fight and proves the same AI casts. It drives state through __dbgAdvance and
  // __dbgSpawn, so SOLO is the default even though the run is deterministic.
  "beastcast",
  // Holds F for 1.4 simulated seconds beside the lead beast and reads whether
  // the hold mounted anything, on both sides of the unlock. A held key the frame
  // loop has to consume, and its clock is __dbgAdvance — see the note above.
  "mounts",
  // Rides a ground beast, teleports it thirty units up and reads where getting
  // on and getting off put the pair of them. It drives state (grant, ride,
  // teleport) and its clock is __dbgAdvance, which steps nothing in a
  // background tab.
  "saddle",
  // Rides a FLYER, reads where its ground contact blob sits, then lifts the pair
  // thirty units and reads it again. Grant, ride and teleport are all state, and
  // its clock is __dbgAdvance.
  "flyshadow",
  // Authors a path into a running world: it mutates the network, drops every
  // chunk and rebuilds them, which is about as much state as a probe can drive.
  // It also re-grounds the hero, so nothing about it is read-only.
  "path-edit",
  // Screenshot pixel diffs across a visibility toggle, so its pages must be the
  // front tab and present real frames — the same reason `waterfall` is here.
  "road-fade",
  // Builds real voxel terrain and meshes it in the LAB, which is a different
  // world from the game's — it opens its own page and drives no hero, but it
  // raycasts a scene it built itself and SOLO is the default.
  "road-lab",
]);

// Verified safe to overlap: each was run alone and then batched, and its output
// was byte-identical both times (bar the favicon 404 the dev server logs). A
// probe joins this list by that A/B and by nothing else — a guess belongs in
// SOLO.
//
// FOUR OF TWENTY-TWO, AND THE REASON THE LIST IS SHORT IS WORTH FIXING RATHER
// THAN WORKING AROUND. A probe here waits a FIXED interval after the canvas
// appears, calibrated on a quiet machine, and most of them then PRINT a reading
// instead of asserting on it — so a batch that boots slower produces a probe
// that read nothing, printed nulls and exited 0. Give a probe a readiness gate
// (wait for `__dbgBoot().playing`, not for 2500 ms) and an assertion with an
// exit code, and it can move up here; until then it runs alone.
//
// AND THERE IS A SECOND GATE NOBODY HAD WRITTEN DOWN, found by running the A/B
// for `content`: A BATCHED PAGE IS A BACKGROUND TAB, AND A BACKGROUND TAB GETS
// NO FRAMES. Only one page in the shared browser is the front one; the rest
// report `visibilityState: 'hidden'`, and Chromium gives a hidden page no
// requestAnimationFrame — measured, a hidden page held W for 1.2 s and travelled
// 0.00 units against 6.39 on the visible one, while its performance clock and
// every read-only debug hook carried on answering normally. So the bar for this
// list is not only "no timing assertions": a probe that DRIVES THE HERO AT ALL —
// a key edge, a held key, anything the frame loop has to consume — belongs in
// SOLO however patient its polling is. That is the same root cause as `f2`
// reading null under load, named.
const PARALLEL = [
  "zfight",
  "path-profile",
  "road-anchor",
  "water-shore",
  "f16",
  "crosshair",
  "viewport",
  "cursor",
];
const ALL = [...PARALLEL, ...SOLO];

const argv = process.argv.slice(2);
const names = [];
let jobs = 1,
  json = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--jobs") {
    jobs = Math.max(1, Number(argv[++i]) || 1);
  } else if (a === "--json") {
    json = true;
  } else if (a === "all") {
    names.push(...ALL);
  } else if (a.startsWith("--")) {
    console.error(`unknown flag ${a}`);
    process.exit(2);
  } else {
    names.push(a.replace(/^test-/, "").replace(/\.mjs$/, ""));
  }
}
if (!names.length) {
  console.error(`usage: bun tools/probe.mjs <name...|all> [--jobs N] [--json]\n  ${ALL.join(" ")}`);
  process.exit(2);
}

// A NAME THAT NAMES NO FILE IS A TYPO, AND IT IS CAUGHT HERE RATHER THAN AS A
// module-resolution error four seconds into a spawned child. That is how
// `perf-baseline` hid on the roster above for so long: the failure it produced
// looked exactly like a probe that had run and broken, so it read as somebody
// else's red rather than as an entry pointing at nothing.
const missing = names.filter((n) => !existsSync(join(ROOT, "tools", `test-${n}.mjs`)));
if (missing.length) {
  console.error(`no such probe: ${missing.join(", ")}
  known: ${ALL.join(" ")}`);
  process.exit(2);
}

const logDir = join(tmpdir(), "bs-probe");
mkdirSync(logDir, { recursive: true });

// These probes open no browser at all, so they need neither the shared browser
// nor the dev server. Everything else does.
const HEADLESS = new Set(["zfight", "path-profile", "road-anchor", "water-shore", "f16"]);
const needsBrowser = names.some((n) => !HEADLESS.has(n));
const browser = needsBrowser ? await launchBrowser() : null;
const env = { ...process.env, BS_PORT: String(PORT) };
if (browser) {
  env.BS_BROWSER_WS = browser.wsEndpoint();
}

const runOne = (name) =>
  new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("bun", [`tools/test-${name}.mjs`], { env, shell: true });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      out += d;
    });
    child.on("close", (code) => {
      const log = join(logDir, `${name}.log`);
      writeFileSync(log, out);
      resolve({ name, code: code ?? 1, ms: Date.now() - started, log, out });
    });
  });

/**
 * Close every page the finished probes left behind. MEMORY HYGIENE, and it is
 * worth being precise that it is ONLY that.
 *
 * A probe's pages outlive the probe: `launchBrowser` remaps `close()` to
 * `disconnect()` for the shared browser (tools/browser.mjs — the next probe in
 * the batch still needs it alive), so every page a child opened is still open
 * after the child has exited. Measured here, `keybinds` leaves two behind. A
 * whole `all` run therefore ends holding a few dozen live game pages, each with
 * its own WebGL context; a leaked run of this suite was caught holding 4 GB.
 *
 * IT IS NOT THE FIX FOR THE BATCH FLAKE, and the first version of this comment
 * claimed it was. The theory was that leaked pages starve later probes of
 * requestAnimationFrame. Measured, all three legs of that are false: the pages
 * are visible to the parent, a page with three others open still reports
 * `visibilityState: 'visible'` and 166 rAF callbacks a second, and — decisively
 * — with this sweep in place `probe.mjs menu keybinds dive` still failed with
 * `dive` starting on a clean browser of exactly one page. What actually breaks
 * those probes is a single unretried keypress; see `leaveSplash` in
 * tools/browser.mjs.
 *
 * KEEPS pages[0], the about:blank the launch came up with. Closing every page
 * can let the browser decide it has nothing left to do and exit under the rest
 * of the batch.
 */
async function reapPages() {
  if (!browser) {
    return 0;
  }
  const pages = await browser.pages().catch(() => []);
  const doomed = pages.slice(1);
  for (const pg of doomed) {
    await pg.close().catch(() => {});
  }
  return doomed.length;
}

const results = [];
const line = (r) =>
  `${r.code === 0 ? "ok  " : "FAIL"} ${r.name.padEnd(13)} ${(r.ms / 1000).toFixed(1)}s`;

// CONVERTED NAMES GO THROUGH THE SUITE, as one child sharing one booted world
// (tools/suite.mjs; the roster and its order live in tools/suite/roster.mjs).
// This is where `probe.mjs all` gets its speedup: every converted probe costs
// the roster one boot between them instead of one boot each. The suite child
// reports per-probe results out of its --json summary, so the terminal shows
// the same one-line-per-probe verdicts either way, and a converted name asked
// for alone still takes this path — the suite with one module IS the solo run.
const converted = names.filter((n) => CONVERTED.includes(n));
const batched = names.filter((n) => !CONVERTED.includes(n) && !SOLO.has(n));
const solo = names.filter((n) => !CONVERTED.includes(n) && SOLO.has(n));

if (converted.length) {
  const started = Date.now();
  const r = await new Promise((resolve) => {
    const child = spawn("bun", ["tools/suite.mjs", "--json", ...converted], { env, shell: true });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      out += d;
    });
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
  const ms = Date.now() - started;
  // One log for the run plus a per-probe verdict line each, parsed out of the
  // summary. A suite that died before printing JSON is reported as one failed
  // entry per requested name rather than silently dropped.
  const log = join(logDir, "suite.log");
  writeFileSync(log, r.out);
  let summary = null;
  try {
    summary = JSON.parse(r.out.slice(r.out.indexOf("{")));
  } catch {
    /* died early */
  }
  for (const n of converted) {
    const fails = summary
      ? summary.fails.filter((f) => f.startsWith(`[${n}]`))
      : [`the suite child did not report (exit ${r.code}) — see ${log}`];
    const secMs = summary
      ? Object.entries(summary.sectionMs)
          .filter(([k]) => k.startsWith(`${n}.`))
          .reduce((a, [, v]) => a + v, 0)
      : ms;
    results.push({
      name: n,
      code: fails.length ? 1 : 0,
      ms: secMs,
      log,
      out: fails.join("\n"),
    });
    if (!json) {
      console.log(line(results[results.length - 1]));
    }
  }
  if (summary && !json) {
    console.log(
      `     suite: ${converted.length} probes on one boot ` +
        `(${(summary.bootMs / 1000).toFixed(1)}s boot, ${(ms / 1000).toFixed(1)}s total)`,
    );
  }
  await reapPages();
}

const queue = [...batched];
const workers = Array.from({ length: Math.min(jobs, queue.length) }, async () => {
  while (queue.length) {
    const r = await runOne(queue.shift());
    results.push(r);
    if (!json) {
      console.log(line(r));
    }
  }
});
await Promise.all(workers);
// AFTER the pool has drained, never inside a worker: with `--jobs 2` or more
// the batched probes genuinely do overlap, and a sweep between two of them
// would close the pages of one that is still running. Here every worker has
// finished, so everything still open is abandoned by construction.
await reapPages();

for (const n of solo) {
  const r = await runOne(n);
  results.push(r);
  if (!json) {
    console.log(line(r));
  }
  // Solo is strictly one at a time — that is what the list MEANS — so there is
  // never another probe whose pages this could take out from under it. This is
  // the sweep that matters: the solo chain is twenty probes long and it is
  // where the pile used to build up.
  await reapPages();
}

// close(), not disconnect(): this is a REAL launch (the runner's own env has no
// BS_BROWSER_WS — only its children do), and disconnecting first leaves the
// process alive so the profile directory cannot be removed. Measured: EBUSY on
// puppeteer_dev_chrome_profile-*, and a non-zero exit from a run that passed.
await browser?.close();

const failed = results.filter((r) => r.code !== 0);
if (json) {
  console.log(
    JSON.stringify({
      pass: results.length - failed.length,
      fail: failed.length,
      probes: results.map((r) => ({ name: r.name, ok: r.code === 0, ms: r.ms, log: r.log })),
    }),
  );
} else {
  console.log(`\n${results.length - failed.length}/${results.length} ok  ·  logs in ${logDir}`);
  // A failure prints its tail here rather than making the reader open the log:
  // the last lines are where every probe in this directory puts its verdict.
  for (const r of failed) {
    console.log(`\n--- ${r.name} (exit ${r.code}) ---`);
    console.log(r.out.trim().split("\n").slice(-14).join("\n"));
  }
}
process.exit(failed.length ? 1 : 0);
