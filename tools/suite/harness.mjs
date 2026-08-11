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
import { frame, launchBrowser, newPage, whenPlaying } from '../browser.mjs';
import { BASE as HOST } from '../target.mjs';

/**
 * Default boot query: muted, no menu, no fullscreen resize under a probe, and
 * NO PERSISTENCE.
 *
 * `nostore=1` (issue #171) is here for the same reason `fs=0` is: a probe that
 * is measuring something else must not have the ground moved under it. With
 * persistence on, a shared-roster run would create save records on whatever
 * machine it ran on and land an autosave — a write, a promise and an IndexedDB
 * transaction — inside a frame somebody is timing. tools/test-saves.mjs is the
 * one probe that leaves it off, because the store is what it is testing.
 */
const BOOT_QUERY = 'menu=0&fs=0&nostore=1';

/**
 * Boot the game once and wait on STATE — `playing` is the last thing the
 * staged boot sets, so it is the boot's own definition of done.
 */
export async function bootGamePage(browser, { query = BOOT_QUERY, width = 1280, height = 800 } = {}) {
  const page = await newPage(browser, { width, height });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(`${HOST}/?${query}`, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await whenPlaying(page);
  return page;
}

/**
 * Advance any page's simulation `s` seconds, then let one real frame present
 * it. The standalone form of `ctx.adv`, for sections that legitimately own a
 * page of their own (a fresh-boot reproduction, a capture framing) and still
 * want simulated time on it.
 */
export async function advance(page, s) {
  return page.evaluate(async (sec) => {
    const out = window.__dbgAdvance(sec);
    await new Promise((resv) => requestAnimationFrame(() => requestAnimationFrame(resv)));
    return out;
  }, s);
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
      const r = await advance(page, s);
      advWall += r.wallMs ?? 0;
      advSim += r.simSeconds ?? 0;
      return r;
    },
    /**
     * Let one REAL frame run (two rAFs — the first may be the tail of the
     * frame already in flight). Two distinct jobs:
     *
     *   * a key the game reads FRAME-side (F2, F3, F10, I — see `frame()` in
     *     main.ts) must see a real frame between the press and the next `adv`,
     *     because `__dbgAdvance` ends each virtual frame with
     *     `input.endFrame()`, which clears the un-consumed edge;
     *   * a measurement of the RENDERED frame (a draw count off the F2
     *     overlay, a screenshot) needs the state it just changed to have been
     *     presented.
     */
    frame: () => frame(page),
    waitFn: (fn, timeout = 30000) => page.waitForFunction(fn, { timeout }),
    advanceStats: () => ({
      simSeconds: +advSim.toFixed(1),
      wallMs: +advWall.toFixed(0),
      speedup: advWall > 0 ? +((advSim * 1000) / advWall).toFixed(1) : null,
    }),
  };
  /**
   * Drain the chunk streamer in SIMULATED time after a teleport. Each advanced
   * slice carries the full per-frame build budget (see __dbgAdvance), so this
   * is the fast-forward form of "wait on `__dbgZone().streaming`, not a clock".
   * Returns false if it never settled — the caller's assertion will say so
   * louder, but a section can bail early on it.
   */
  ctx.settleStreaming = async (maxSimS = 30) => {
    for (let i = 0; i < maxSimS * 2; i++) {
      if (!(await page.evaluate(() => !!window.__dbgZone && !window.__dbgZone().streaming))) {
        await ctx.adv(0.5);
        continue;
      }
      return true;
    }
    return false;
  };
  return ctx;
}

/**
 * The standard reset between MODULES — the whole of what one converted probe
 * may assume about the page the previous one left behind. Deliberately small:
 * a reset that tried to guarantee more (kill every enemy, rewind every clock)
 * would be a second implementation of `exitToTitle`, drifting from the real
 * one. Mount off, mounts re-locked, held keys up — the three things a probe
 * leaves behind by DRIVING, which is what probes do.
 *
 * The re-lock is what keeps `unlockMounts` honest: a module that rides asks for
 * the unlocks in its own first section, so one that does NOT ask must not
 * inherit them from whoever ran before it and pass for the wrong reason.
 */
async function resetBetween(page) {
  await page.evaluate(() => window.__dbgRide && window.__dbgRide('off'));
  await page.evaluate(() => window.__dbgUnlockMount && window.__dbgUnlockMount('all', false));
  for (const k of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'KeyC']) {
    await page.keyboard.up(k).catch(() => {});
  }
}

/**
 * Bond every beast, for a module that needs one to mount.
 *
 * Since issue #4 a new game is bonded to nothing (`grantBeast` in main.ts), and
 * several modules say nothing at all without a beast — carrier flies one under
 * the island, deepwater rides a swimmer into the basin, gamepad holds Y.
 *
 * A MODULE CALLS THIS FOR ITSELF, in its first section, rather than the harness
 * doing it between modules. Two reasons, and the second is the one that decided
 * it: `pause` genuinely exits to the title and `exitToTitle` clears ownership
 * along with the bag, so a grant that happened once would be gone by the fourth
 * module — and a module run ALONE (`bun tools/test-gamepad.mjs`) never sees a
 * between-modules reset at all, so it would pass in the suite and fail on its
 * own. Asking for what you need where you need it survives both.
 *
 * `all` rather than a pair, because a module that wants a Finnick should not
 * have to know which two some other module happened to leave in the slots.
 */
export async function bondAll(ctx) {
  await ctx.ev(() => window.__dbgGrantBeast && window.__dbgGrantBeast('all'));
  // CHECKED, not assumed. Everything the calling module goes on to do depends
  // on there being a beast to mount, and the failure of a silent grant is a
  // section three screens later reporting that a held button never mounted —
  // which reads as a gamepad bug and is not one.
  const party = await ctx.ev(() => {
    const t = window.__dbgTaming?.();
    return t ? { owned: t.owned.length, lead: t.lead, support: t.support } : null;
  });
  ctx.res.party = party;
  ctx.check(!!party && party.owned > 0 && party.lead !== null,
    `bondAll left the party as ${JSON.stringify(party)} — nothing below can mount`);
  return party;
}

/**
 * Hand over all three mount unlocks, for a module that needs to RIDE.
 *
 * `bondAll`'s twin, one gate further along and asked for the same way. Riding is
 * three story unlocks and a new character has none of them, so a module that
 * mounts must say so — a held Y that never mounts otherwise reads as a gamepad
 * bug, which is the exact failure `bondAll`'s note describes.
 *
 * A MODULE CALLS THIS FOR ITSELF, and it is not in `BOOT_QUERY`: the boot query
 * is shared by every module in a batch, and `mounts=all` there would quietly
 * unlock riding for probes that have no business seeing it unlocked. A probe
 * with a page of its own passes `mounts=all` in its URL instead; only
 * tools/test-mounts.mjs deliberately does neither, because the lock is what it
 * is testing.
 */
export async function unlockMounts(ctx) {
  await ctx.ev(() => window.__dbgUnlockMount && window.__dbgUnlockMount('all', true));
  // CHECKED, not assumed — same argument bondAll makes about a silent grant.
  const unlocked = await ctx.ev(() => window.__dbgMount?.().unlocked ?? null);
  ctx.res.mountUnlocks = unlocked;
  ctx.check(Array.isArray(unlocked) && unlocked.length === 3,
    `unlockMounts left the unlocks as ${JSON.stringify(unlocked)} — nothing below can mount`);
  return unlocked;
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
