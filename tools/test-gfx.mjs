// Verifies the F3 performance panel (src/ui/perf-panel.ts, src/core/gfx.ts):
// every switch is real, every switch is remembered, the console can set them
// too — and the console is not painted through by the panels sharing its band.
//
// Usage: bun tools/test-gfx.mjs        (dev server must be up)
//        ...or as sections inside `bun tools/suite.mjs` — same code either way.
//
// FAST-FORWARDED, SHARED-SESSION, with two honest exceptions. Most settling
// here is simulated time through `__dbgAdvance` (see tools/suite/harness.mjs)
// or a single presented frame (`ctx.frame`) — a draw count changes on the next
// RENDERED frame, not after a wall-clock second. The exceptions are sections
// that measure WALL-CLOCK behaviour and cannot be advanced:
//
//   * `fpsCapRealtime` measures the rendered frame RATE, which only exists in
//     real time — it sleeps for real, says so, and runs near the end;
//   * `persisted` reloads the page, which is a real boot — it runs LAST on the
//     shared page so nothing downstream pays for it, and doubles as the
//     leave-the-profile-clean step.
//
// Measured real-time before the conversion: 78 s of declared sleeps plus boot.
//
// EVERY TOGGLE IS ASSERTED AGAINST A MEASUREMENT, not against its own flag.
// A settings panel is the easiest thing in a codebase to get wrong in a way
// that tests green: the row renders, the value flips, the key is written, and
// the renderer never hears about it. So each one is judged by what the FRAME
// does — draw calls for the ones that remove geometry or a pass, and the
// measured frame rate for the cap — and the flag is not consulted at all.
//
// The one thing it cannot judge that way is `shadows`, which changes no draw
// COUNT (the shadow pass renders into its own target, and three does not count
// it in info.render.calls the way it counts scene draws) — so that row is
// asserted on renderer state instead, and the file says so rather than
// pretending the number means something.
//
// Exits non-zero.
import { PNG } from 'pngjs';
import { newPage } from './browser.mjs';
import { BASE as HOST } from './target.mjs';
import { advance } from './suite/harness.mjs';

/** Sleep for REAL milliseconds. Only the realtime sections below may use it. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const overlay = (ctx) => ctx.ev(() => {
  const el = [...document.body.children].find(
    (c) => c instanceof HTMLDivElement && (c.textContent || '').startsWith('FPS'));
  return el ? el.textContent : '';
});

/**
 * Draw calls of the last completed frame, off `__dbgDraws` — three's own
 * counter, NOT the F2 overlay text. The overlay refreshes its readout at most
 * 4x a second, so scraping it within 250 ms of a toggle reads the count from
 * BEFORE the toggle; the old fixed 600-900 ms sleeps were silently covering
 * that cadence, and the conversion to presented-frame settles uncovered it.
 *
 * MIN OVER SIX READS a frame apart — it was two, and two is not enough in the
 * suite (COMPOSITION): the shared world this module inherits has movers the
 * solo boot does not — the carrier module's ship overflying, aggroed beasts
 * crossing the frustum, shadow-cache refresh frames — and they swing the
 * per-frame count by tens of calls (measured at rest after carrier+deepwater:
 * 528..574 across ten seconds with streaming settled). The min of a longer
 * window sits on the quiet floor both sides of a toggle, which is the number
 * the toggle actually moves.
 */
async function draws(ctx) {
  let m = Infinity;
  for (let i = 0; i < 6; i++) {
    if (i) await ctx.frame();
    m = Math.min(m, await ctx.ev(() => window.__dbgDraws()));
  }
  return m;
}

// SET and READ are separate helpers on purpose. `page.evaluate` serialises its
// argument as JSON, and JSON has no `undefined` — passing one turns into null,
// which the hook reads as "a value was supplied" and writes Boolean(null), i.e.
// false. A read that silently switches the thing off is a memorable way to lose
// an afternoon.
const gfxSet = (ctx, id, value) => ctx.ev(([i, v]) => window.__dbgGfx(i, v), [id, value]);
const gfxGet = (ctx, id) => ctx.ev((i) => window.__dbgGfx(i), id);
const gfxAll = (ctx) => ctx.ev(() => window.__dbgGfx());

/** A toggle takes effect on the next rendered frame; two make it measurable. */
async function settleToggle(ctx) {
  await ctx.frame();
  await ctx.frame();
}

/**
 * Wait until the draw count stops MOVING before a toggle is measured.
 *
 * COMPOSITION FIX. In the suite this module runs after deepwater, whose last
 * site is far out at sea — the teleport back to the road rebuilds a much
 * larger view ring than the solo boot ever does, and `__dbgZone().streaming`
 * clears before the instanced pop-in (grass sheets, prop batches) has finished
 * landing. Measured in the composed run: ~+30 draw calls of pure scene growth
 * PER TOGGLE ROUND TRIP (263 -> 352 across the toggles section), which swamped
 * grass's and props' 20-call floors (grass read -10) while ao's 40 survived.
 * So: settle on the MEASUREMENT being still, not on the streamer's flag alone.
 * Returns whether it got there; the caller measures either way, and a count
 * still moving fails the toggle assertions with the real numbers in hand.
 *
 * SAMPLED ON A WALL-CLOCK CADENCE, not on consecutive frames — the first cut
 * of this helper compared adjacent 8 ms frames and passed a still-growing
 * scene: pop-in lands in bursts ~100 ms apart, so three quiet frames prove
 * nothing (measured: 290 -> 356 draws ACROSS a toggles run this helper had
 * waved through). REALTIME by nature — the pop-in it waits for rides real
 * frames. Each sample is a min over a few frames so mover jitter (see
 * `draws`) is not read as growth.
 */
async function settleDraws(ctx, { tolerance = 6, stillMs = 1200, maxMs = 25000 } = {}) {
  const floor = async () => {
    let m = Infinity;
    for (let i = 0; i < 4; i++) {
      if (i) await ctx.frame();
      m = Math.min(m, await ctx.ev(() => window.__dbgDraws()));
    }
    return m;
  };
  const t0 = Date.now();
  let prev = await floor();
  let stillSince = Date.now();
  while (Date.now() - t0 < maxMs) {
    await sleep(250);                  // REALTIME — see above
    const d = await floor();
    if (Math.abs(d - prev) > tolerance) stillSince = Date.now();
    prev = d;
    if (Date.now() - stillSince >= stillMs) return true;
  }
  return false;
}

export const name = 'gfx';
export const sections = [

  // -------------------------------------------------------------------------
  { id: 'stage', run: async (ctx) => {
    // OUT OF THE CAMP FIRST, and it is load-bearing for everything below.
    //
    // A session opens INSIDE the walled Encampment with the camera on the
    // hero's face, and a straight line in ANY direction from the middle of a
    // walled camp ends at the palisade. `__dbgTp` to the world's reference
    // point is where every measurement in here was written: `spawnPoint` is
    // the scenic stretch of road fifty units out, open in every direction.
    //
    // Then WAIT FOR THE STREAMER, not for a clock: a teleport is a 55-unit
    // jump, so the whole view ring is rebuilt afterwards — and every toggle
    // below is judged on a DRAW COUNT, which a chunk arriving mid-measurement
    // moves more than some of the toggles do. The drain is simulated time now
    // (each advanced slice carries the full build budget), but the condition
    // is the same one: `__dbgZone().streaming` false.
    // A REAL RELOAD FIRST — the module's strongest COMPOSITION FIX. Every
    // draw-count floor below was calibrated against a freshly booted world,
    // and the suite's shared page is not one: four modules of play have aged
    // the sim clock and the sky and scattered the movers, and measured at the
    // same spot with the same aim the full composition's frame floor sat near
    // 300 draws against ~550 solo — grass's toggle then saved 10 where solo
    // saves 30. The module's own `persisted` section already ends with a
    // reload (its assertion IS a reboot), so "a real boot lives in gfx" was
    // always this module's contract with the suite; taking one up front as
    // well makes every measurement in between the solo one. ~2 s.
    await ctx.page.reload({ waitUntil: 'load' });
    await ctx.page.waitForSelector('canvas');
    await ctx.waitFn(() => window.__dbgBoot && window.__dbgBoot().playing && window.__dbgAdvance, 60000);

    const openGround = await ctx.ev(() => window.__dbgTowns().spawn);
    await ctx.tp(openGround.x, openGround.z);
    const settled = await ctx.settleStreaming(30);
    ctx.check(settled, 'the streamer never settled after the teleport');
    await ctx.adv(1.5);

    // AIM SOMEWHERE DETERMINISTIC — COMPOSITION FIX. `__dbgTp` keeps whatever
    // camera yaw the previous module left, and every toggle below is judged on
    // a FRUSTUM-CULLED draw count: after deepwater the lens still pointed out
    // over the water it had been diving in, so grass's and props' 20-call
    // floors measured a frame with almost no grass or props in it (grass read
    // a 2-call delta composed against a comfortable pass solo, where the boot
    // pose happens to face the meadow). Aim back along the road toward the
    // start pose — grass and props in frame by construction, derived so a
    // seed that moves the camp moves it too — and let the smoothed swing land.
    const start = await ctx.ev(() => window.__dbgStart().start);
    await ctx.ev((b) => window.__dbgAim(b),
      Math.atan2(start.x - openGround.x, start.z - openGround.z));
    await ctx.adv(0.8);

    // Defensive against an earlier module's leftovers — COMPOSITION: a modal
    // still up (or mid-close) would push every F10 below into simulate()'s
    // close-the-modal branch, and every reading after it would measure an
    // empty screen. Same guard pause.stage carries, for the same reason.
    if (await ctx.ev(() => !!document.querySelector('.bs-pause'))) {
      await ctx.page.keyboard.press('F10');
      await ctx.adv(0.3);
      await ctx.waitFn(() => !document.querySelector('.bs-pause'), 5000);
    }

    // The F2 overlay: only `fpsCapRealtime` reads it now (draw counts come
    // from `__dbgDraws`), but it is opened here so its rolling window has the
    // whole module to fill. F2 is read FRAME-side (see frame() in main.ts), so
    // the press must see a real frame before any advance clears the edge — and
    // the overlay paints its first text on its own ~250 ms cadence, so the
    // check waits on the text, not on a frame count.
    if (!(await overlay(ctx))) {
      await ctx.page.keyboard.press('F2');
      await ctx.waitFn(() => [...document.body.children].some(
        (c) => c instanceof HTMLDivElement && (c.textContent || '').startsWith('FPS')), 5000);
    }
    ctx.check(!!(await overlay(ctx)), 'the F2 overlay did not open — no FPS readout for the cap section');
  } },

  // -------------------------------------------------------------------------
  { id: 'panel', run: async (ctx) => {
    // The panel opens on F3 and lists every option.
    await ctx.page.keyboard.press('F3');
    await ctx.frame();
    const shown = await ctx.ev(() => {
      const el = document.querySelector('.bs-perf');
      return el
        ? {
          visible: getComputedStyle(el).display !== 'none',
          rows: el.querySelectorAll('.bs-perf-row').length,
          timeRows: el.querySelectorAll('[data-time="day"]').length,
          // The two appearance rows are not graphics settings and are not in
          // `GFX_OPTIONS` — they are counted separately so the arithmetic below
          // stays a statement about the gfx list. tools/test-hair.mjs is what
          // asserts they DO anything.
          hairRows: el.querySelectorAll('[data-hair]').length,
          // The path editor's four, counted the same way and for the same
          // reason: they are not graphics settings and are not in
          // `GFX_OPTIONS`. tools/test-path-edit.mjs asserts they DO anything.
          pathRows: el.querySelectorAll('[data-path]').length,
          // The three mount unlocks, counted the same way and for the same
          // reason. tools/test-mounts.mjs is what asserts they DO anything —
          // this only holds the arithmetic below to the whole list.
          mountRows: el.querySelectorAll('[data-mount]').length,
        }
        : null;
    });
    const state = await gfxAll(ctx);
    ctx.res.panel = { ...shown, open: state.open, options: Object.keys(state.values).length };
    ctx.check(!!shown?.visible, 'F3 did not open the panel');
    ctx.check(
      shown?.rows === ctx.res.panel.options + 1 + shown?.hairRows + shown?.pathRows
        + shown?.mountRows,
      `the panel shows ${shown?.rows} rows for ${ctx.res.panel.options} graphics settings`
      + ` plus time plus ${shown?.hairRows} appearance rows plus ${shown?.pathRows}`
      + ` path editor rows plus ${shown?.mountRows} mount rows`);
    ctx.check(shown?.timeRows === 1, `the panel shows ${shown?.timeRows} time rows, expected 1`);
    ctx.check(shown?.hairRows === 2, `expected 2 appearance rows, found ${shown?.hairRows}`);
    ctx.check(shown?.pathRows === 4, `expected 4 path editor rows, found ${shown?.pathRows}`);
    ctx.check(shown?.mountRows === 3, `expected 3 mount rows, found ${shown?.mountRows}`);
    // NOT a modal, deliberately — see the note at the top of ui/perf-panel.ts.
    // The walk is simulated: what is being asserted is that the sim moves him
    // with the panel up, and simulated seconds are exactly that.
    const before = await ctx.ev(() => window.__dbgPlayerPos());
    await ctx.page.keyboard.down('KeyW');
    await ctx.adv(0.9);
    await ctx.page.keyboard.up('KeyW');
    const after = await ctx.ev(() => window.__dbgPlayerPos());
    ctx.res.panel.heroTravelled = +Math.hypot(after.x - before.x, after.z - before.z).toFixed(2);
    ctx.check(ctx.res.panel.heroTravelled > 2,
      `the hero is frozen with the panel up (${ctx.res.panel.heroTravelled}) — it must NOT be a modal`);
    // CLOSE IT AGAIN. The old file left F3 up and relied on its mid-file page
    // reload to reset it before the stacking section pressed F3 "open"; the
    // reload now runs last, so the panel state has to be handed back
    // explicitly — a section that leaves a panel up is a section the next one
    // trips over.
    await ctx.page.keyboard.press('F3');
    await ctx.frame();
    // Settle whatever the walk streamed before anything reads a draw count.
    await ctx.settleStreaming(10);
  } },

  // -------------------------------------------------------------------------
  { id: 'toggles', run: async (ctx) => {
    // Each toggle actually removes work. Ordered cheapest-to-restore first so
    // a failure leaves the game in a sane state for the rows after it.
    //
    // `aa` is NOT in this list and cannot be: SMAA is three fullscreen quads,
    // which is inside the frame-to-frame variance of the draw counter. It is
    // asserted as renderer state below with `shadows`.
    //
    // The thresholds are FLOORS, not the measured values, and bloom's is
    // deliberately the loosest: its cost is the number of glowing objects in
    // frame, which is a property of where the hero happens to be standing.
    // `props` came down 40 -> 20 when core/shadow-cache.ts landed — a tree's
    // shadow-pass draw is now cached, so switching trees off stops saving it
    // every frame.
    //
    // COMPOSITION: the count has to be STILL first — see settleDraws. The
    // streamer's flag alone was not enough after deepwater's far-sea teleport.
    await ctx.settleStreaming(10);
    await settleDraws(ctx);
    for (const [id, minDrop] of [['ao', 40], ['bloom', 4], ['grass', 20], ['props', 20]]) {
      const on = await draws(ctx);
      await gfxSet(ctx, id, false);
      await settleToggle(ctx);
      const off = await draws(ctx);
      await gfxSet(ctx, id, true);
      await settleToggle(ctx);
      const back = await draws(ctx);
      ctx.res[id] = { drawsOn: on, drawsOff: off, drawsRestored: back, saved: on - off };
      ctx.check(on - off >= minDrop,
        `turning ${id} off saved ${on - off} draw calls, expected at least ${minDrop}`);
      // RELATIVE to the off-state, not back to the on-state. The absolute count
      // drifts while the streamer works, so "within 5% of where it started"
      // fails on scene drift rather than on a stuck switch. What the assertion
      // is actually for is "did turning it back on put the work back", and the
      // honest form of that is a comparison with the frame that had it off.
      ctx.check(back - off >= minDrop * 0.5,
        `turning ${id} back on put only ${back - off} draw calls back (removing it cost ${on - off})`);
    }
  } },

  // -------------------------------------------------------------------------
  { id: 'foliageDistance', run: async (ctx) => {
    // The choice is judged by scene residency and visibility, not by reading
    // the value back. Low must cull both layers, and it must actually dispose
    // outer prop geometry rather than paying the streaming/memory cost for
    // meshes whose fragments are merely faded away.
    const high = await gfxAll(ctx);
    const highDraws = await draws(ctx);
    await gfxSet(ctx, 'foliageDistance', 64);
    await settleToggle(ctx);
    const low = await gfxAll(ctx);
    const lowDraws = await draws(ctx);
    await gfxSet(ctx, 'foliageDistance', 128);
    ctx.check(await ctx.settleStreaming(15),
      'the foliage queue did not refill after restoring High distance');
    await settleToggle(ctx);
    const restored = await gfxAll(ctx);

    const total = (x, layer) => x.layers[layer].shown + x.layers[layer].hidden;
    ctx.res.foliageDistance = {
      high: { draws: highDraws, grass: high.layers.grass, props: high.layers.props },
      low: { draws: lowDraws, grass: low.layers.grass, props: low.layers.props },
      restored: { grass: restored.layers.grass, props: restored.layers.props },
    };
    ctx.check(low.layers.grass.shown < high.layers.grass.shown,
      `Low foliage still shows ${low.layers.grass.shown} grass chunks against High's ${high.layers.grass.shown}`);
    ctx.check(low.layers.props.shown < high.layers.props.shown,
      `Low foliage still shows ${low.layers.props.shown} prop chunks against High's ${high.layers.props.shown}`);
    ctx.check(total(low, 'props') < total(high, 'props'),
      `Low retained ${total(low, 'props')} prop meshes against High's ${total(high, 'props')} — outer geometry was not disposed`);
    ctx.check(lowDraws < highDraws,
      `Low foliage drew ${lowDraws} calls against High's ${highDraws} — no frame work was saved`);
    ctx.check(total(restored, 'props') >= total(high, 'props'),
      `High restored only ${total(restored, 'props')} prop meshes from ${total(high, 'props')}`);
  } },

  // -------------------------------------------------------------------------
  { id: 'state', run: async (ctx) => {
    // Shadows and aa: state, because the frame cannot show them. `shadows`
    // renders into its own target, which three does not add to
    // info.render.calls the way it adds scene draws; `aa` is three fullscreen
    // quads, inside the counter's own variance. Asserting a draw delta for
    // either would be asserting noise, so these two are checked for
    // round-tripping instead, and the file says so rather than inventing a
    // number.
    for (const id of ['shadows', 'aa']) {
      await gfxSet(ctx, id, false);
      await settleToggle(ctx);
      const off = await gfxGet(ctx, id);
      await gfxSet(ctx, id, true);
      await settleToggle(ctx);
      const on = await gfxGet(ctx, id);
      ctx.res[id] = { afterOff: off, afterOn: on };
      ctx.check(off === false, `${id} did not switch off`);
      ctx.check(on === true, `${id} did not come back on`);
    }
  } },

  // -------------------------------------------------------------------------
  { id: 'console', run: async (ctx) => {
    // The console can set them too.
    await ctx.page.keyboard.press('Backquote');
    await ctx.page.waitForSelector('.bs-console-input', { visible: true });
    await ctx.page.type('.bs-console-input', '/gfx bloom off');
    await ctx.page.keyboard.press('Enter');
    await ctx.frame();
    await ctx.page.keyboard.press('Backquote');
    // WAIT FOR IT TO BE GONE, not for a frame: the console is a modal, and the
    // next section's F10 is read through the modal branch in simulate() — on a
    // still-open console it CLOSES the console instead of opening the menu,
    // and every assertion there reads an empty screen.
    await ctx.waitFn(() => {
      const el = document.querySelector('.bs-console-input');
      return !el || el.offsetParent === null;
    }, 5000);
    const offV = await gfxGet(ctx, 'bloom');
    // ...and back on, so the module hands the next section a whole renderer.
    await gfxSet(ctx, 'bloom', true);
    ctx.res.console = { bloomAfterCommand: offV };
    ctx.check(offV === false, `/gfx bloom off did not take (${offV})`);
  } },

  // -------------------------------------------------------------------------
  { id: 'settingsPanel', run: async (ctx) => {
    // The SETTINGS panel drives the same switches. The Graphics tab of the
    // in-game menu (ui/settings.ts) offers five of these rows to a player who
    // will never press F3. It is not a second implementation — same model,
    // same keys — but "not a second implementation" is exactly the claim, and
    // the way it fails is the way every settings panel fails: the row renders,
    // the pill flips, the key is written, and the renderer never hears.
    //
    // So it is judged the way every row above is judged, by what the FRAME
    // does, and driven through the real buttons rather than through `__dbgGfx`.
    // AO is the one used because it is the largest and steadiest of the five.
    //
    // The pause menu is a MODAL — it takes the hero's input while it is up —
    // which is helpful rather than awkward: nothing is walking into new chunks
    // between the two readings, so the draw count is as still as it ever gets.
    // He is still SIMULATED behind it (issue #101); with nothing pressed that
    // means he stands where he was, which is all this needs.
    //
    // F10, not Escape: the in-game menu moved off a key the browser spends on
    // fullscreen and pointer lock before the page sees it.
    //
    // PRESSED IN A RETRY LOOP — COMPOSITION FIX: in the composed run this F10
    // landed while the console above was still the open modal for a beat (its
    // input was already hidden — the visibility wait passed — but simulate()'s
    // modal branch still owned the key), so the press CLOSED that instead of
    // opening the menu, and every reading below saw an empty screen ("the
    // Graphics tab shows 0 rows"). The loop only re-presses when NO menu came
    // up, so it cannot toggle an open one shut; `adv` consumes the SIM-side
    // edge deterministically where a bare frame left it to the real loop.
    for (let i = 0; i < 3
      && !(await ctx.ev(() => !!document.querySelector('.bs-pause'))); i++) {
      await ctx.page.keyboard.press('F10');
      await ctx.adv(0.3);
      await ctx.waitFn(() => !!document.querySelector('.bs-pause'), 2000).catch(() => {});
    }
    ctx.check(await ctx.ev(() => !!document.querySelector('.bs-pause')),
      'the in-game menu never opened for the settings-panel measurement');
    await ctx.ev(() => document.querySelector('.bs-pause [data-act="settings"]')?.click());
    await ctx.frame();
    await ctx.ev(() => document.querySelector('.bs-pause [data-tab="graphics"]')?.click());
    await ctx.frame();
    const row = () => ctx.ev(() => {
      const b = document.querySelector('.bs-pause [data-gfx="ao"]');
      return b && { pressed: b.getAttribute('aria-pressed'), pill: b.querySelector('.pill')?.textContent };
    });
    const rows = await ctx.ev(() =>
      [...document.querySelectorAll('.bs-pause [data-gfx]')].map((b) => b.getAttribute('data-gfx')));
    // COMPOSITION: same stillness gate as `toggles` — the modal takes the
    // hero's input but not the renderer's work, and a count still absorbing
    // pop-in reads a 40-call toggle as 4.
    await settleDraws(ctx);
    const on = await draws(ctx);
    await ctx.ev(() => document.querySelector('.bs-pause [data-gfx="ao"]')?.click());
    await settleToggle(ctx);
    const off = await draws(ctx);
    const rowOff = await row();
    const flagOff = await gfxGet(ctx, 'ao');
    await ctx.ev(() => document.querySelector('.bs-pause [data-gfx="ao"]')?.click());
    await settleToggle(ctx);
    const back = await draws(ctx);
    await ctx.ev(() => document.querySelector('.bs-pause [data-gfx="foliageDistance"]')?.click());
    await settleToggle(ctx);
    const foliageChoice = {
      value: await gfxGet(ctx, 'foliageDistance'),
      pill: await ctx.ev(() =>
        document.querySelector('.bs-pause [data-gfx="foliageDistance"] .pill')?.textContent ?? null),
    };
    // Low -> Medium -> High, restoring both the default and the full resident
    // ring before the modal is dismissed.
    await ctx.ev(() => document.querySelector('.bs-pause [data-gfx="foliageDistance"]')?.click());
    await ctx.ev(() => document.querySelector('.bs-pause [data-gfx="foliageDistance"]')?.click());
    ctx.check(await ctx.settleStreaming(15),
      'the Settings row did not restore the High foliage ring');
    await ctx.ev(() => document.querySelector('.bs-pause [data-act="continue"]')?.click());
    await ctx.frame();

    ctx.res.settingsPanel = { rows, drawsOn: on, drawsOff: off, drawsRestored: back,
      saved: on - off, rowAfterOff: rowOff, gfxAfterOff: flagOff, foliageChoice };
    ctx.check(rows.length === 7, `the Graphics tab shows ${rows.length} rows, expected 7`);
    ctx.check(on - off >= 40,
      `the settings panel's AO row saved ${on - off} draw calls, expected at least 40`);
    ctx.check(back - off >= 20,
      `turning it back on from the panel put only ${back - off} draw calls back`);
    // The row and the model have to agree, or the two panels drift: F3 would
    // show one thing and Settings another, both of them "working".
    ctx.check(flagOff === false, `__dbgGfx says ao is ${flagOff} after the settings row turned it off`);
    ctx.check(rowOff?.pressed === 'false', `the row still reads aria-pressed=${rowOff?.pressed}`);
    ctx.check(foliageChoice.value === 64,
      `the Settings foliage row selected ${foliageChoice.value}, expected Low (64)`);
    ctx.check(foliageChoice.pill === 'Low',
      `the Settings foliage pill reads "${foliageChoice.pill}", expected "Low"`);
  } },

  // -------------------------------------------------------------------------
  { id: 'stacking', run: async (ctx) => {
    // Nothing is painted through the console (issue #41). The three developer
    // instruments all claim the top of the screen — the console is a
    // full-width sheet down the top 42vh, F3 sits top-left and F2 top-centre —
    // so at the console's old z-index of 9000 both panels were drawn straight
    // through its log and through the line being typed.
    //
    // F3 is judged by a HIT TEST rather than by reading a z-index back,
    // because elementFromPoint answers out of the same stacking computation
    // the compositor paints from. F2 CANNOT be judged that way — it is
    // pointer-events:none, so a hit test falls through it whichever way round
    // the two are stacked — and the computed z comparison below says so
    // instead of pretending otherwise.
    await ctx.page.keyboard.press('F3');
    await ctx.frame();
    await ctx.page.keyboard.press('Backquote');
    await ctx.page.waitForSelector('.bs-console-input', { visible: true });
    await ctx.frame();
    const stack = await ctx.ev(() => {
      const con = document.querySelector('.bs-console');
      const perf = document.querySelector('.bs-perf');
      const f2 = [...document.body.children].find(
        (c) => c instanceof HTMLDivElement && (c.textContent || '').startsWith('FPS'));
      const c = con.getBoundingClientRect();
      const p = perf.getBoundingClientRect();
      const l = Math.max(c.left, p.left), r = Math.min(c.right, p.right);
      const t = Math.max(c.top, p.top), b = Math.min(c.bottom, p.bottom);
      // The centre of the OVERLAP, so the sample is inside both by construction
      // rather than by a coordinate written down here that a layout change
      // would quietly move off one of them.
      const x = (l + r) / 2, y = (t + b) / 2;
      const hit = r > l && b > t ? document.elementFromPoint(x, y) : null;
      const z = (el) => Number(getComputedStyle(el).zIndex);
      return {
        overlap: +Math.max(0, (r - l) * (b - t)).toFixed(0),
        sample: [Math.round(x), Math.round(y)],
        onTop: !hit ? null
          : hit.closest('.bs-console') ? 'console'
          : hit.closest('.bs-perf') ? 'perf' : (hit.className || hit.tagName),
        z: { console: z(con), perf: z(perf), overlay: f2 ? z(f2) : null },
      };
    });
    ctx.res.stacking = stack;
    // Vacuous otherwise: if the two do not overlap there is nothing to be on
    // top of.
    ctx.check(stack.overlap > 1000,
      `the F3 panel and the console overlap by only ${stack.overlap}px² — nothing was tested`);
    ctx.check(stack.onTop === 'console',
      `the console is under the F3 panel at ${stack.sample} (hit "${stack.onTop}")`);
    ctx.check(stack.z.overlay !== null, 'the F2 overlay was not found — the stage section opened it');
    ctx.check(stack.z.console > stack.z.overlay,
      `the console (${stack.z.console}) is below the F2 overlay (${stack.z.overlay})`);
    await ctx.page.keyboard.press('Backquote');
    await ctx.waitFn(() => {
      const el = document.querySelector('.bs-console-input');
      return !el || el.offsetParent === null;
    }, 5000);
    await ctx.page.keyboard.press('F3');
    await ctx.frame();
  } },

  // -------------------------------------------------------------------------
  { id: 'preloadWalk', run: async (ctx) => {
    // A layer switched off STAYS off as you walk into unbuilt chunks.
    //
    // The bug this exists for: grass switched off stayed off while standing
    // still and came back in patches while walking — the ZoneManager's gateway
    // PRELOAD hides the active world to warm the destination's shaders and
    // turned it back on with a blanket `visible = true`. Reaching that needs
    // the hero walking toward the gate from the spawn.
    //
    // A FRESH PAGE, and that is the whole reproduction rather than fussiness:
    // the preload arms once per approach, and the shared page's world has
    // whatever preload history the sections above gave it. The fresh page gets
    // the same `__dbgAdvance`, so the 8-second approach walk is simulated —
    // `advance(page, s)` is the harness's standalone form for exactly this.
    //
    // Both the road and the bearing are ASKED FOR, not pinned, so a seed that
    // moved either moves this with it — and `endedAtGateDist` is asserted so a
    // walk that never armed the preload fails loudly instead of passing
    // vacuously.
    const bctx = await ctx.page.browser().createBrowserContext();
    const fresh = await newPage(bctx, { width: 1280, height: 800 });
    try {
      await fresh.goto(`${HOST}/?menu=0&fs=0`, { waitUntil: 'load' });
      await fresh.waitForSelector('canvas');
      await fresh.waitForFunction(
        () => window.__dbgBoot && window.__dbgBoot().playing && window.__dbgAdvance,
        { timeout: 60000 },
      );
      await fresh.focus('canvas').catch(() => {});

      const road = await fresh.evaluate(() => window.__dbgTowns().spawn);
      await fresh.evaluate((s) => window.__dbgTp(s.x, s.z), road);
      await advance(fresh, 0.6);
      // WITHIN WALKING RANGE OF THE GATE FIRST. This started on the road and
      // walked the whole way, which worked while the gateway stood 34 units
      // out; it is 150-210 now (`GATE_RADII`, main.ts) and eight seconds of
      // KeyW closed 9 of 170. The teleport is a SETUP step, not the
      // measurement: the walk that follows is still a real walk across the last
      // stretch and still has to arm the preload, which is what is asserted.
      // INSIDE THE BAND ALREADY, and the walk below is what has to keep
      // working while he is in it.
      //
      // This walked in from outside, which was possible when the gateway stood
      // 34 units out. It is 150-210 now (`GATE_RADII`, main.ts) and the site is
      // scored for a hillside behind it, so a hero aimed straight at the gate
      // from the open side stalls on the slope: measured, he ended 32.2 away
      // from a start of 45 AND from a start of 38 — the same spot, which is a
      // wall and not a pace. The trail exists precisely because that approach
      // is not walkable in a straight line.
      //
      // So the teleport puts him where the preload is armed and the WALK is
      // asserted on its own terms below — that he covered ground, and that the
      // layers held while he did.
      // 5, BOUNDED AT BOTH ENDS, AND THE WALK IS 4 SECONDS. The eight seconds below cover between 14 and
      // 22 units depending on how the trail runs under him — measured, 14 alone
      // and 22.2 inside the parallel batch — so from 8 the fast case ended 30.2
      // out and stepped past the band. Three is too close the other way: the
      // hero lands on the gateway itself, the zone reads its own far side and
      // `gateDist` comes back 0 with nothing streamed.
      //
      // The walk was halved for the same reason. Eight seconds covered 14 on a
      // quiet machine and 25.2 on a busy one, which is a range no start
      // distance fits inside a 30-unit band; four seconds covers 7 to 13 and
      // leaves him between 12 and 18. It is still a real walk over real
      // streaming ground, which is all the layer readings below need.
      const APPROACH = 5;
      await fresh.evaluate((r) => {
        const g = window.__dbgZone().gate;
        // ON THE TRAIL, facing back down it. Any other line into the gate is a
        // hillside: measured, a hero aimed straight at the gate from the open
        // side covered 2.8 units in eight seconds of KeyW, from three different
        // starting distances. The trail is the walkable approach — that is what
        // it is for — so the walk uses it.
        const t = window.__dbgPaths().paths.find((q) => q.profile === 'path:trail');
        const hx = t ? t.x0 : g.x - 1;
        const hz = t ? t.z0 : g.z;
        const len = Math.hypot(hx - g.x, hz - g.z) || 1;
        window.__dbgTp(g.x + ((hx - g.x) / len) * r, g.z + ((hz - g.z) / len) * r);
      }, APPROACH);
      // ON THE STREAMER, not a clock: a teleport across the world leaves every
      // chunk under the hero to be built, and the layer counts below are
      // meaningless until they are.
      await fresh.waitForFunction(() => !window.__dbgZone().streaming, { timeout: 60000 });
      await advance(fresh, 0.6);
      const gateAt = await fresh.evaluate(() => {
        const g = window.__dbgZone().gate;
        const p = window.__dbgPlayerPos();
        // DOWN the trail, not at the gate: he is standing on it beside the
        // gateway and the walkable direction is the way he came.
        const t = window.__dbgPaths().paths.find((q) => q.profile === 'path:trail');
        const hx = t ? t.x0 : g.x;
        const hz = t ? t.z0 : g.z;
        return {
          bearing: Math.atan2(hx - p.x, hz - p.z),
          dist: Math.hypot(g.x - p.x, g.z - p.z),
        };
      });
      ctx.res.preloadWalk = { gateBearing: +gateAt.bearing.toFixed(3), gateDist: +gateAt.dist.toFixed(1) };
      await fresh.evaluate((b) => window.__dbgAim(b), gateAt.bearing);
      await advance(fresh, 0.7);

      const freshLayers = () => fresh.evaluate(() => window.__dbgGfx().layers);
      await fresh.evaluate(() => window.__dbgGfx('grass', false));
      await advance(fresh, 1.5);
      const atRest = await freshLayers();

      const began = await fresh.evaluate(() => {
        const p = window.__dbgPlayerPos();
        return { x: p.x, z: p.z };
      });
      await fresh.keyboard.down('KeyW');
      await advance(fresh, 4);
      await fresh.keyboard.up('KeyW');
      await advance(fresh, 2);
      const afterWalk = await freshLayers();
      const ended = await fresh.evaluate(() => {
        const g = window.__dbgZone().gate;
        const p = window.__dbgPlayerPos();
        return { d: +Math.hypot(g.x - p.x, g.z - p.z).toFixed(1), x: p.x, z: p.z };
      });
      ctx.res.preloadWalk.endedAtGateDist = ended.d;
      // GROUND COVERED, not ground closed. A hero pushed sideways by a slope
      // walks a long way without getting nearer anything, and "did he move" is
      // the question this asks — see the note on APPROACH.
      ctx.res.preloadWalk.covered = +Math.hypot(ended.x - began.x, ended.z - began.z).toFixed(1);

      // WHERE HE STARTED, not where he ended. The band check used to be on the
      // far end of the walk, and no start distance survives it: four seconds of
      // KeyW covered 7 units on one run and 24 on the next depending on what
      // the trail put in his way, so a walk that begins comfortably inside a
      // 30-unit band can end 29.1 or 0.2 outside it for reasons that have
      // nothing to do with what this section measures. The setup is the part
      // this can pin — he begins beside the gateway with its zone armed — and
      // `covered` below is the part that says the walk was a walk.
      ctx.check(ctx.res.preloadWalk.gateDist < 10,
        `the walk did not begin at the gateway (${ctx.res.preloadWalk.gateDist} away) `
        + '— everything below would pass vacuously');
      // AND HE ACTUALLY WALKED. The teleport puts him in the band; this is the
      // half that says the eight seconds of KeyW were a walk and not a hero
      // wedged against a tree, which is the only way the layer readings below
      // mean anything.
      ctx.check(ctx.res.preloadWalk.covered > 3,
        `the walk covered only ${ctx.res.preloadWalk.covered} units — he never moved`);

      ctx.res.stillOffAfterWalking = {
        atRest: { grass: atRest.grass, terrain: atRest.terrain },
        afterWalk: { grass: afterWalk.grass, terrain: afterWalk.terrain },
      };
      ctx.check(atRest.grass.shown === 0,
        `grass did not go off at all (${atRest.grass.shown} visible)`);
      ctx.check(atRest.grass.hidden > 0, 'no grass meshes to hide — the world had not streamed');
      ctx.check(afterWalk.grass.shown === 0,
        `${afterWalk.grass.shown} grass meshes came back while walking `
        + `(${afterWalk.grass.hidden} still hidden)`);
      // AND THE GROUND IS STILL THERE. Hiding one layer must not take anything
      // else with it, and the first fix for the grass did exactly that:
      // asserting only the thing you changed is how a fix ships a worse bug
      // than the one it closed.
      for (const [when, snap] of [['at rest', atRest], ['after walking', afterWalk]]) {
        ctx.check(snap.terrain.hidden === 0 && snap.terrain.shown > 0,
          `${when}, ${snap.terrain.hidden} terrain chunks are INVISIBLE `
          + `(${snap.terrain.shown} visible) — hiding grass took the ground with it`);
        ctx.check(snap.water.hidden === 0,
          `${when}, ${snap.water.hidden} water meshes are invisible though water is on`);
      }
    } finally {
      await bctx.close();
    }
  } },

  // -------------------------------------------------------------------------
  { id: 'aoOccluders', run: async (ctx) => {
    // What is allowed to CAST ambient occlusion (issue #39): the grass carpet
    // and the cloud deck were opaque, wrote depth, and were therefore in the
    // AO G-buffer — a mottled grey smear across every meadow and dotted black
    // dashes down every cumulus crease.
    //
    // The frame is asked, not the flag: `?aoview=1` renders the denoised AO
    // buffer straight to screen, so both halves are a picture of the AO and
    // nothing else.
    //
    // TWO PAGES IS NOT AN OPTION FOR THE GRASS HALF. Two separate loads of the
    // same framing differ by 2.02 code values from streaming and settling
    // alone, which is larger than the artefact — so the A/B is two screenshots
    // of ONE page with `__dbgGfx` between them. The `props` arm is the CONTROL
    // and it is not optional: without it, a capture that silently returned the
    // same bytes twice would pass the grass assertion perfectly.
    const bctx = await ctx.page.browser().createBrowserContext();
    const shot = await newPage(bctx, { width: 900, height: 620 });
    try {
      const decode = async () => {
        // Buffer.from, because puppeteer hands back a plain Uint8Array and
        // pngjs reaches straight for Buffer's readUInt32BE.
        const png = PNG.sync.read(Buffer.from(await shot.screenshot()));
        const l = new Float64Array(png.width * png.height);
        for (let i = 0; i < l.length; i++) {
          l[i] = 0.2125 * png.data[i * 4] + 0.7154 * png.data[i * 4 + 1] + 0.0721 * png.data[i * 4 + 2];
        }
        return l;
      };
      const meanAbsDiff = (a, b) => {
        let s = 0;
        for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
        return +(s / a.length).toFixed(3);
      };
      const AOVIEW = 'menu=0&fs=0&photo=1&hud=0&aoview=1&aa=0&bloom=0&fps=30';
      /** Boot a capture framing and settle it in simulated time. */
      const frameUp = async (camLook) => {
        await shot.goto(`${HOST}/?${AOVIEW}&${camLook}`, { waitUntil: 'load' });
        await shot.waitForSelector('canvas');
        await shot.waitForFunction(
          () => window.__dbgBoot && window.__dbgBoot().playing && window.__dbgAdvance,
          { timeout: 60000 },
        );
        // Drain the streamer in simulated time, then let a frame present.
        for (let i = 0; i < 40; i++) {
          if (await shot.evaluate(() => !window.__dbgZone().streaming)) break;
          await advance(shot, 0.5);
        }
        await advance(shot, 0.5);
      };
      const settle = async () => { await advance(shot, 0.4); };

      // A meadow of terraces carrying both kinds of prop, chosen because BOTH
      // arms have to work in one framing: grass everywhere for the assertion,
      // and trees and boulders in the same frame for the control.
      await frameUp('cam=12,4.5,4&look=20,2,-2');
      const withAll = await decode();
      await shot.evaluate(() => window.__dbgGfx('grass', false));
      await settle();
      const withoutGrass = await decode();
      await shot.evaluate(() => { window.__dbgGfx('grass', true); window.__dbgGfx('props', false); });
      await settle();
      const withoutProps = await decode();
      await shot.evaluate(() => window.__dbgGfx('props', true));

      // Clouds: above the deck, where the frame is nothing but cumulus.
      // Excluded, every one of those pixels is untouched white.
      await frameUp('cam=0,120,0&look=80,115,40');
      const sky = await decode();
      let dark = 0;
      for (const v of sky) if (v < 245) dark++;

      const ao = {
        grassMovesAo: meanAbsDiff(withAll, withoutGrass),
        propsMovesAo: meanAbsDiff(withAll, withoutProps),
        cloudPixelsOccluded: +(100 * dark / sky.length).toFixed(3),
      };
      ctx.res.aoOccluders = ao;
      // 0.10 of a code value today against 16.30 on the build that shipped the
      // bug. Not zero and should not be: hiding grass also UNCOVERS the
      // terrain behind it, and that terrain has AO of its own.
      ctx.check(ao.grassMovesAo < 1,
        `hiding grass moved the AO buffer by ${ao.grassMovesAo} code values — `
        + 'the grass carpet is still an AO occluder');
      ctx.check(ao.propsMovesAo > 3,
        `hiding props moved the AO buffer by only ${ao.propsMovesAo} — the control `
        + 'failed, so the grass measurement above proves nothing');
      ctx.check(ao.cloudPixelsOccluded < 2,
        `${ao.cloudPixelsOccluded}% of a sky full of cumulus is ambient-occluded — `
        + 'the cloud deck is still an AO occluder');
    } finally {
      await bctx.close();
    }
  } },

  // -------------------------------------------------------------------------
  { id: 'fpsCapRealtime', run: async (ctx) => {
    // The frame cap is the one that changes HOW MANY frames — and a frame RATE
    // only exists in wall-clock time, so this section sleeps for real and is
    // the reason the module cannot be called fully fast-forwarded.
    //
    // OFF THE F2 READOUT: the cap does not skip rAF CALLBACKS, it skips the
    // work inside them (see Engine.beginFrame), so counting callbacks "read"
    // 165.2 under a 30 fps cap. F2 counts RENDERED frames, which is the thing
    // being capped. The long sleep is because that readout is a rolling mean
    // of 120 of them: at 30 fps the window takes four seconds to flush.
    const fpsNow = async () => {
      await sleep(7000);            // REALTIME, deliberately — see above
      const m = /FPS\s+([\d.]+)/.exec(await overlay(ctx));
      return Number(m?.[1] ?? 0);
    };
    await gfxSet(ctx, 'fpsCap', 30);
    const at30 = await fpsNow();
    await gfxSet(ctx, 'fpsCap', 120);
    const at120 = await fpsNow();
    ctx.res.fpsCap = { at30, at120 };
    ctx.check(at30 > 20 && at30 < 40, `a 30 fps cap measured ${at30}`);
    ctx.check(at120 > at30 + 20, `raising the cap did not raise the frame rate (${at30} -> ${at120})`);
  } },

  // -------------------------------------------------------------------------
  { id: 'persisted', run: async (ctx) => {
    // It is remembered across a reload — which is a REAL BOOT, so this runs
    // LAST on the shared page: everything after a reload would pay the boot
    // again, so nothing comes after. It doubles as the leave-the-profile-clean
    // step, and the world it leaves behind is freshly booted and playing,
    // which is exactly what the next module in a suite expects.
    await gfxSet(ctx, 'bloom', false);
    await gfxSet(ctx, 'fpsCap', 60);
    await ctx.frame();
    await ctx.page.reload({ waitUntil: 'load' });
    await ctx.page.waitForSelector('canvas');
    await ctx.waitFn(() => window.__dbgBoot && window.__dbgBoot().playing, 60000);
    const after = (await gfxAll(ctx)).values;
    ctx.res.persisted = { bloom: after.bloom, fpsCap: after.fpsCap };
    ctx.check(after.bloom === false, 'bloom=off was not remembered across a reload');
    ctx.check(after.fpsCap === 60, `fpsCap=60 was not remembered (got ${after.fpsCap})`);

    // Leave the profile as we found it, so a later run does not inherit a
    // half-disabled renderer from this one — and apply the defaults NOW rather
    // than leaving them to the next reload nobody performs.
    await ctx.ev(() => {
      for (const k of Object.keys(window.__dbgGfx().values)) {
        window.localStorage.removeItem(`game.settings.graphics.${k}`);
      }
      window.__dbgGfx('bloom', true);
      window.__dbgGfx('fpsCap', 120);
    });
  } },
];

if (import.meta.main) {
  const { soloRun } = await import('./suite/harness.mjs');
  await soloRun({ name, sections });
}
