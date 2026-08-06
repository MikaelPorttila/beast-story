// The shared-session probe harness: one booted world, many test sections.
//
// WHY THIS EXISTS. `bun tools/probe.mjs all` spent ~15 minutes on a roster
// whose real work is seconds: ~17 s of boot per probe times ~28 serial SOLO
// probes, plus minutes of `wait(N)` sleeps waiting for the frame loop to drain
// simulation slices at wall-clock speed. `__dbgAdvance` (main.ts) killed the
// sleeps — this file kills the boots. A CONVERTED probe exports its sections
// instead of booting a world of its own, and `tools/suite.mjs` runs many
// probes' sections against ONE booted page, teleporting between sites.
//
// THE CONTRACT. A converted probe file exports:
//
//   export const name = 'carrier';
//   export const sections = [
//     { id: 'attach', run: async (ctx) => { ... } },
//   ];
//   if (import.meta.main) (await import('./suite/harness.mjs')).soloRun({ name, sections });
//
// Sections in one file may share state through their own module scope — they
// run in order, on one page, and that order is the author's contract. ACROSS
// files the harness guarantees only the standard reset (see `resetBetween`):
// mounts off, input released. A section that poisons more than that — loads a
// content package, swaps zone — must say so in its own comments and run last.
//
// `if (import.meta.main)` is what keeps the old contract alive: running
// `bun tools/test-carrier.mjs` boots a page of its own and runs only that
// file's sections, exactly as before, so `probe.mjs` and a person iterating on
// one probe see no difference but the speed.
//
// THE CTX. Sections get one object:
//
//   page       the puppeteer page
//   adv(s)     advance the SIMULATION s seconds (see __dbgAdvance), then let
//              one real frame present it — HUD-side hooks (the compass) read
//              frame state, and a screenshot needs a presented frame
//   tp(x,z,y?) teleport (carries a mount — see __dbgTp in main.ts)
//   ev(fn,...) page.evaluate, shortened
//   check(ok, msg)   collect a failure (does not throw — a section reports
//                    everything it measured, like every probe in tools/)
//   res        this module's results object; write findings into it
//
// Timing discipline: `wait(N)` does not exist here, on purpose. A section
// settles on STATE (waitFn) or advances SIMULATED time (adv) — the twenty-first
// probe copies whichever it sees, so the harness only offers the right two.
import { launchBrowser, newPage } from '../browser.mjs';
import { BASE as HOST } from '../target.mjs';

/** Default boot query: muted, no menu, no fullscreen resize under a probe. */
const BOOT_QUERY = 'menu=0&fs=0';

/**
 * Boot the game once and wait on STATE — `playing` is the last thing the
 * staged boot sets, so it is the boot's own definition of done.
 */
export async function bootGamePage(browser, { query = BOOT_QUERY, width = 1280, height = 800 } = {}) {
  const page = await newPage(browser, { width, height });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(`${HOST}/?${query}`, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await page.waitForFunction(
    () => window.__dbgBoot && window.__dbgBoot().playing && window.__dbgAdvance,
    { timeout: 60000 },
  );
  return page;
}

/** Build the ctx one module's sections share. `res`/`fails` are the module's. */
function makeCtx(page, res, fails) {
  let advWall = 0;
  let advSim = 0;
  const ctx = {
    page,
    res,
    check: (ok, msg) => { if (!ok) fails.push(msg); },
    ev: (fn, ...args) => page.evaluate(fn, ...args),
    tp: (x, z, y) => page.evaluate(([a, b, c]) => window.__dbgTp(a, b, c), [x, z, y]),
    adv: async (s) => {
      const r = await page.evaluate(async (sec) => {
        const out = window.__dbgAdvance(sec);
        await new Promise((resv) => requestAnimationFrame(() => requestAnimationFrame(resv)));
        return out;
      }, s);
      advWall += r.wallMs ?? 0;
      advSim += r.simSeconds ?? 0;
      return r;
    },
    waitFn: (fn, timeout = 30000) => page.waitForFunction(fn, { timeout }),
    advanceStats: () => ({
      simSeconds: +advSim.toFixed(1),
      wallMs: +advWall.toFixed(0),
      speedup: advWall > 0 ? +((advSim * 1000) / advWall).toFixed(1) : null,
    }),
  };
  return ctx;
}

/**
 * The standard reset between MODULES — the whole of what one converted probe
 * may assume about the page the previous one left behind. Deliberately small:
 * a reset that tried to guarantee more (kill every enemy, rewind every clock)
 * would be a second implementation of `exitToTitle`, drifting from the real
 * one. Mount off, held keys up — the two things a probe leaves behind by
 * DRIVING, which is what probes do.
 */
async function resetBetween(page) {
  await page.evaluate(() => window.__dbgRide && window.__dbgRide('off'));
  for (const k of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'KeyC']) {
    await page.keyboard.up(k).catch(() => {});
  }
}

/**
 * Run modules' sections against one page. Returns per-module results and a
 * flat failure list; prints one line per section so a hung section is visible
 * by name rather than as silence.
 */
export async function runModules(modules, page, { log = console.error } = {}) {
  const out = { modules: {}, fails: [], sections: 0, ms: {} };
  for (const mod of modules) {
    const res = {};
    const fails = [];
    const ctx = makeCtx(page, res, fails);
    for (const s of mod.sections) {
      const t0 = Date.now();
      try {
        await s.run(ctx);
      } catch (e) {
        // A thrown section is a failed section, not a dead run: the sections
        // after it still measure what they measure.
        fails.push(`${mod.name}.${s.id} threw: ${e.message}`);
      }
      const ms = Date.now() - t0;
      out.ms[`${mod.name}.${s.id}`] = ms;
      out.sections++;
      log(`  ${fails.length ? '..' : 'ok'} ${mod.name}.${s.id}  ${(ms / 1000).toFixed(1)}s`);
    }
    res.advance = ctx.advanceStats();
    out.modules[mod.name] = res;
    out.fails.push(...fails.map((f) => `[${mod.name}] ${f}`));
    await resetBetween(page);
  }
  return out;
}

/**
 * The solo path: `bun tools/test-<name>.mjs` boots its own browser and page and
 * runs just that file's sections. Same harness, same ctx, same output shape —
 * a probe behaves identically alone and in the suite, which is the property
 * probe.mjs was built around.
 */
export async function soloRun(mod, opts = {}) {
  const browser = await launchBrowser();
  try {
    const page = await bootGamePage(browser, opts);
    const out = await runModules([mod], page);
    console.log(JSON.stringify(
      { ...out.modules[mod.name], fails: out.fails, pass: out.fails.length === 0 },
      null, 2,
    ));
    if (out.fails.length) {
      console.error(`\n${out.fails.length} failure(s):\n  ${out.fails.join('\n  ')}`);
      process.exitCode = 1;
    }
  } finally {
    // In a probe.mjs batch this is remapped to disconnect() — see browser.mjs.
    await browser.close();
  }
}
