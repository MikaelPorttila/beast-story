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
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchBrowser } from './browser.mjs';
import { PORT } from './target.mjs';

// Probes that assert on frame rate, elapsed motion or CPU cost. Never batched.
// Three of these are here because a batch was RUN and the output moved, which
// is the only evidence worth putting a name on either list for:
//   sway        slots 3 -> 4, areaRadius 11.94 -> 18.56 (more movers per frame)
//   aim-assist  widestSelected 66.29 deg -> 0.18, narrowestRefused null
//   f2          the overlay had not been built yet 2.5 s after the canvas, so
//               every reading came back null — AND THE PROBE STILL EXITED 0,
//               because it asserts nothing. See the note on silent probes below.
const SOLO = new Set([
  'perf-baseline', // the whole point of it is a cpu/frame number
  'gamepad',       // section 7 compares look rate across fps caps
  'touch',         // sums yaw deltas over a stick hold
  'beastanim',     // per-frame rotation deltas
  'dive',          // ascent speed in units/second
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
for (const n of solo) {
  const r = await runOne(n);
  results.push(r);
  if (!json) console.log(line(r));
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
