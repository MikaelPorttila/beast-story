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
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser.mjs';
import { PORT } from './target.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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
  'gamepad',       // section 7 compares look rate across fps caps
  'touch',         // sums yaw deltas over a stick hold
  'beastanim',     // per-frame rotation deltas
  'dive',          // ascent speed in units/second
  // Drives four different bodies at a coastline and measures how far each got,
  // plus a mounted top speed on either side of a waterline. Every one of those
  // is elapsed motion, and it mounts through __dbgRide, which drives state.
  'deepwater',
  'menu',          // menuShownAtMs, and a held W measured against another hold
  'keybinds',      // one section runs UNCAPPED on purpose
  'pause',         // held-W distances either side of the menu
  'structures',    // walk distances into colliders
  'npc',           // walks to a talk range
  'road',          // drives the hero along a carriageway
  'gfx',           // draw-call counts under a live frame cap
  'sway',          // measured: mover count and area radius move under load
  'aim-assist',    // measured: selection angles collapse under load
  'f2',            // measured: reads null under load, and asserts nothing
  'settings',      // measured: drained cue count 2 -> 1, lastKind changed
  'nature',        // rebuilds ~90 chunks per section and counts their vertices
  // Its fade assertions are a wall-clock envelope read a fixed time after a
  // track starts, and it walks the staged boot to New Game — both of the things
  // that go wrong when three games share a GPU. SOLO is also the default.
  'music',
  'textsize',      // stages the HUD through __dbgStageHud after a fixed wait
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
  'content',
  // Drives the hero with a pad button, holds him in the air on a 16 ms interval
  // and asserts on an enemy's hp either side of a swing. Every one of those is a
  // frame the loop has to run.
  'proximity',
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
const PARALLEL = ['zfight', 'crosshair', 'viewport', 'cursor'];
const ALL = [...PARALLEL, ...SOLO];

const argv = process.argv.slice(2);
const names = [];
let jobs = 1, json = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--jobs') jobs = Math.max(1, Number(argv[++i]) || 1);
  else if (a === '--json') json = true;
  else if (a === 'all') names.push(...ALL);
  else if (a.startsWith('--')) { console.error(`unknown flag ${a}`); process.exit(2); }
  else names.push(a.replace(/^test-/, '').replace(/\.mjs$/, ''));
}
if (!names.length) {
  console.error(`usage: bun tools/probe.mjs <name...|all> [--jobs N] [--json]\n  ${ALL.join(' ')}`);
  process.exit(2);
}

// A NAME THAT NAMES NO FILE IS A TYPO, AND IT IS CAUGHT HERE RATHER THAN AS A
// module-resolution error four seconds into a spawned child. That is how
// `perf-baseline` hid on the roster above for so long: the failure it produced
// looked exactly like a probe that had run and broken, so it read as somebody
// else's red rather than as an entry pointing at nothing.
const missing = names.filter((n) => !existsSync(join(ROOT, 'tools', `test-${n}.mjs`)));
if (missing.length) {
  console.error(`no such probe: ${missing.join(', ')}
  known: ${ALL.join(' ')}`);
  process.exit(2);
}

const logDir = join(tmpdir(), 'bs-probe');
mkdirSync(logDir, { recursive: true });

// test-zfight.mjs opens no browser at all (it is arithmetic over the rigs), so
// it needs neither the shared browser nor the dev server. Everything else does.
const needsBrowser = names.some((n) => n !== 'zfight');
const browser = needsBrowser ? await launchBrowser() : null;
const env = { ...process.env, BS_PORT: String(PORT) };
if (browser) env.BS_BROWSER_WS = browser.wsEndpoint();

const runOne = (name) => new Promise((resolve) => {
  const started = Date.now();
  const child = spawn('bun', [`tools/test-${name}.mjs`], { env, shell: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('close', (code) => {
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
  if (!browser) return 0;
  const pages = await browser.pages().catch(() => []);
  const doomed = pages.slice(1);
  for (const pg of doomed) await pg.close().catch(() => {});
  return doomed.length;
}

const results = [];
const line = (r) => `${r.code === 0 ? 'ok  ' : 'FAIL'} ${r.name.padEnd(13)} ${(r.ms / 1000).toFixed(1)}s`;

// Solo names are pulled out and run one at a time, after the batchable ones.
const batched = names.filter((n) => !SOLO.has(n));
const solo = names.filter((n) => SOLO.has(n));

const queue = [...batched];
const workers = Array.from({ length: Math.min(jobs, queue.length) }, async () => {
  while (queue.length) {
    const r = await runOne(queue.shift());
    results.push(r);
    if (!json) console.log(line(r));
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
  if (!json) console.log(line(r));
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
  console.log(JSON.stringify({
    pass: results.length - failed.length,
    fail: failed.length,
    probes: results.map((r) => ({ name: r.name, ok: r.code === 0, ms: r.ms, log: r.log })),
  }));
} else {
  console.log(`\n${results.length - failed.length}/${results.length} ok  ·  logs in ${logDir}`);
  // A failure prints its tail here rather than making the reader open the log:
  // the last lines are where every probe in this directory puts its verdict.
  for (const r of failed) {
    console.log(`\n--- ${r.name} (exit ${r.code}) ---`);
    console.log(r.out.trim().split('\n').slice(-14).join('\n'));
  }
}
process.exit(failed.length ? 1 : 0);
