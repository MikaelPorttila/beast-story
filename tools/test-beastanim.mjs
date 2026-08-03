// Beast animation continuity probe.
//
// Prints, per beast and per rig joint, the LARGEST rotation change between two
// consecutive rendered frames. A procedural cycle is continuous by
// construction, so those deltas should stay in the tenths of a radian; a joint
// that swings a radian or more between adjacent frames is not animating, it is
// teleporting, and that is what reads on screen as a flicker or an impossibly
// fast flap.
//
// The run deliberately provokes the cases where a beast's speed spikes: it lets
// the clock accumulate first (the phase error of a `time * freq` cycle scales
// with elapsed time, so a fresh page hides the bug), then yanks the hero around
// with __dbgTp so every beast slams from a standstill into full catch-up follow
// and back.
//
// Usage: bun tools/test-beastanim.mjs [soakSeconds]
import { launchBrowser, newPage, wait, logPageErrors } from './browser.mjs';
import { BASE as HOST } from './target.mjs';

const soak = Number(process.argv[2] ?? 30);
const url = `${HOST}/?fps=0&menu=0`;

const browser = await launchBrowser();
const page = await newPage(browser, { width: 960, height: 600 });
logPageErrors(page);

// The dev server hot-reloads the page whenever anything under src/ is saved,
// which silently wipes the in-page collector mid-run. Notice it and start over
// rather than reporting a truncated sample as if it were a whole one.
let reloaded = false;
page.on('framenavigated', (fr) => { if (fr === page.mainFrame()) reloaded = true; });

async function boot() {
  reloaded = false;
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('canvas', { timeout: 15000 });
  await page.waitForFunction('typeof __dbgBeastAnim === "function"', { timeout: 15000 });
  await page.waitForFunction('__dbgBeastAnim().length > 0', { timeout: 20000 });
  reloaded = false;
  // Let the session clock run. The phase error of a `time * freq` cycle is
  // proportional to `time`, so measuring at t~0 understates it by an order of
  // magnitude.
  await wait(soak * 1000);
}

// Long enough to cycle the whole roster through the two active follow slots
// (']' swaps the primary, '[' the support) — the eight beasts parked in reserve
// sit at moveSpeed 0 and cannot show the bug at all.
const SAMPLE_MS = 26000;

// Start a rAF collector and return immediately: a page.evaluate that stays
// alive for the whole sample dies the moment the renderer hiccups.
const startCollector = (sampleMs) => page.evaluate((sampleMs) => {
  const LOCO = new Set(['idle', 'walk', 'run', 'fly', 'swim']);
  const worst = new Map();   // "beast.part.axis" -> worst per-frame delta
  let prev = null;
  let hops = 0;
  const start = performance.now();
  window.__animProbeState = { worst, done: false, frames: 0, clock: 0 };

  const step = () => {
    const el = performance.now() - start;
    // Provoke the spike: shove the hero to a fresh column every 1.2 s so the
    // beasts alternate between arriving (moveSpeed -> 0) and full catch-up
    // (moveSpeed -> 1). That ramp is where a speed-scaled frequency does its
    // damage, and it is the "teleport / re-anchor" case from the report.
    if (el > hops * 1200) {
      hops++;
      const a = hops * 1.7;
      window.__dbgTp(Math.cos(a) * 14, Math.sin(a) * 14);
    }
    const now = window.__dbgBeastAnim();
    window.__animProbeState.frames++;
    if (now[0]) window.__animProbeState.clock = now[0].time;
    if (prev) {
      for (let i = 0; i < now.length && i < prev.length; i++) {
        const a = prev[i], b = now[i];
        if (a.id !== b.id) continue;
        // Only compare frames that are in the SAME action, and only the
        // locomotion actions. An action change is a deliberate pose cut — a beast
        // snapping out of an attack into a run is meant to move a long way in
        // one frame — and counting those would drown out the thing under test,
        // which is whether a cycle stays continuous WHILE it runs.
        if (a.action !== b.action) continue;
        if (!LOCO.has(b.action)) continue;
        for (const k of Object.keys(b.parts)) {
          const pa = a.parts[k], pb = b.parts[k];
          // The contact blob counter-rotates against the rig root to stay flat
          // on the ground, so its local rotation wraps through +-pi every time
          // the beast turns past south. That is a 2pi bookkeeping step, not
          // motion, and it drowns out everything real. Skip it.
          if (!pa || !pb || k === 'blob') continue;
          for (let ax = 0; ax < 3; ax++) {
            const d = Math.abs(pb[ax] - pa[ax]);
            const key = `${b.id}.${k}.${'xyz'[ax]}`;
            const cur = worst.get(key);
            if (!cur || d > cur.d) worst.set(key, { d, action: b.action, ms: b.moveSpeed, t: b.time });
          }
        }
      }
    }
    prev = now;
    if (el < sampleMs) requestAnimationFrame(step);
    else window.__animProbeState.done = true;
  };
  requestAnimationFrame(step);
}, sampleMs);

const collect = () => page.evaluate(() => {
  const s = window.__animProbeState;
  const rows = [...s.worst.entries()].map(([k, v]) => ({ joint: k, d: v.d, action: v.action, ms: v.ms, t: v.t }));
  rows.sort((a, b) => b.d - a.d);
  const perBeast = new Map();
  for (const r of rows) {
    const id = r.joint.split('.')[0];
    if (!perBeast.has(id)) perBeast.set(id, r);
  }
  return { elapsed: s.clock, frames: s.frames, top: rows.slice(0, 12), perBeast: [...perBeast.values()] };
});

let result = null;
for (let attempt = 1; attempt <= 4 && !result; attempt++) {
  await boot();
  await startCollector(SAMPLE_MS);
  // Rotate the roster while the collector runs, so every species gets a turn as
  // an actually-moving follower.
  await page.focus('canvas').catch(() => {});
  for (let i = 0; i < Math.floor(SAMPLE_MS / 1600) && !reloaded; i++) {
    await wait(1600);
    await page.keyboard.press(i % 2 === 0 ? 'BracketRight' : 'BracketLeft');
  }
  if (!reloaded) await wait(2000);
  if (reloaded) { console.log(`attempt ${attempt}: page reloaded mid-sample, retrying`); continue; }
  result = await collect();
}
if (!result) { console.error('could not complete a sample without a reload'); process.exit(1); }

const f = (n) => n.toFixed(3);
console.log(`session clock ${f(result.elapsed)} s over ${result.frames} sampled frames`);
console.log('\nWORST per-frame rotation delta, by beast:');
for (const r of result.perBeast) {
  console.log(`  ${r.joint.padEnd(30)} ${f(r.d).padStart(9)} rad   (${r.action}, ms=${f(r.ms)}, clock=${f(r.t)}s)`);
}
console.log('\nWORST 12 joints overall:');
for (const r of result.top) {
  console.log(`  ${r.joint.padEnd(30)} ${f(r.d).padStart(9)} rad   (${r.action}, ms=${f(r.ms)}, clock=${f(r.t)}s)`);
}
console.log(JSON.stringify({
  maxDelta: result.top[0]?.d ?? 0,
  maxJoint: result.top[0]?.joint ?? null,
  clock: result.elapsed,
}));

await browser.close();
