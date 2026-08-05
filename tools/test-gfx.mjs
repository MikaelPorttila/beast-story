// Verifies the F3 performance panel (src/ui/perf-panel.ts, src/core/gfx.ts):
// every switch is real, every switch is remembered, the console can set them
// too â€” and the console is not painted through by the panels sharing its band.
//
// Usage: bun tools/test-gfx.mjs        (dev server must be up)
//
// EVERY TOGGLE IS ASSERTED AGAINST A MEASUREMENT, not against its own flag.
// A settings panel is the easiest thing in a codebase to get wrong in a way
// that tests green: the row renders, the value flips, the key is written, and
// the renderer never hears about it. So each one is judged by what the FRAME
// does â€” draw calls for the ones that remove geometry or a pass, and the
// measured frame rate for the cap â€” and the flag is not consulted at all.
//
// The one thing it cannot judge that way is `shadows`, which changes no draw
// COUNT (the shadow pass renders into its own target, and three does not count
// it in info.render.calls the way it counts scene draws) â€” so that row is
// asserted on renderer state instead, and the file says so rather than
// pretending the number means something.
//
// Exits non-zero.
import { PNG } from 'pngjs';
import { launchBrowser, newPage, wait } from './browser.mjs';
import { BASE as HOST } from './target.mjs';

const browser = await launchBrowser();
const page = await newPage(browser, { width: 1280, height: 800 });
page.on('pageerror', (e) => console.error('[page]', e.message));
await page.goto(`${HOST}/?menu=0&fs=0&debug=1`, { waitUntil: 'load' });
await page.waitForSelector('canvas');
await wait(8000);
await page.focus('canvas').catch(() => {});

const results = {};
const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); };

const overlay = () => page.evaluate(() => {
  const el = [...document.body.children].find(
    (c) => c instanceof HTMLDivElement && (c.textContent || '').startsWith('FPS'));
  return el ? el.textContent : '';
});
/** Draw calls this frame, off the F2 readout the engine already maintains. */
async function draws() {
  // Two reads a few frames apart: the counter is per-frame and a chunk finishing
  // in the sampled frame would otherwise read as a change the toggle caused.
  const a = /draws\s+(\d+)/.exec(await overlay());
  await wait(600);
  const b = /draws\s+(\d+)/.exec(await overlay());
  return Math.min(Number(a?.[1] ?? 0), Number(b?.[1] ?? 0));
}
// SET and READ are separate helpers on purpose. `page.evaluate` serialises its
// argument as JSON, and JSON has no `undefined` â€” passing one turns into null,
// which the hook reads as "a value was supplied" and writes Boolean(null), i.e.
// false. A read that silently switches the thing off is a memorable way to lose
// an afternoon.
const gfxSet = (id, value) => page.evaluate(
  ([i, v]) => window.__dbgGfx(i, v), [id, value]);
const gfxGet = (id) => page.evaluate((i) => window.__dbgGfx(i), id);
const gfxAll = () => page.evaluate(() => window.__dbgGfx());

// Let the streamer finish before any of this: a chunk arriving mid-measurement
// moves the draw count more than some of the toggles do.
//
// OUT OF THE CAMP FIRST, and it is load-bearing for everything below.
//
// A session now opens INSIDE the walled Encampment, beside the fire, with the
// camera on the hero's FACE (World.playerStart). Two things follow and this
// file trips over both: a held W runs from the lens through him into the huts
// (measured, 2.73 units and then a wall, where the same hold along his own
// facing travels 8.66), and a straight line in ANY direction from the middle
// of a walled camp ends at the palisade unless it goes through the gate. So
// aiming is not enough — aimed at the gateway, eight seconds of walking closed
// 4.3 units of a 43.2-unit approach.
//
// `__dbgTp` to the world's reference point is what this file used to get for
// free: `spawnPoint` is the scenic stretch of road fifty units out, which is
// where every measurement in here was taken when it was written, and it is open
// in every direction. Saying so explicitly is better than a spawn that happens
// to be convenient — that is what just stopped being true.
const openGround = await page.evaluate(() => window.__dbgTowns().spawn);
await page.evaluate((s) => window.__dbgTp(s.x, s.z), openGround);
await wait(500);
await page.keyboard.down('KeyW');
await wait(3000);
await page.keyboard.up('KeyW');
// WAIT FOR THE STREAMER, not for a clock. A teleport is a 55-unit jump, so the
// whole view ring is rebuilt afterwards — and every toggle below is judged on a
// DRAW COUNT, which a chunk arriving mid-measurement moves more than some of
// the toggles do. A fixed 2500 ms was enough when the hero booted here and only
// ever walked; measured after the jump it is not, and the failure is a good
// one to recognise: `propsOff` came back as MINUS 17 draw calls, i.e. the scene
// grew while the pass that was supposed to shrink it was switched off.
await page.waitForFunction(
  () => window.__dbgZone && !window.__dbgZone().streaming, { timeout: 30000 },
);
await wait(1500);

// ---------- the panel opens on F3 and lists every option --------------------
{
  await page.keyboard.press('F3');
  await wait(500);
  const shown = await page.evaluate(() => {
    const el = document.querySelector('.bs-perf');
    return el ? { visible: getComputedStyle(el).display !== 'none', rows: el.querySelectorAll('.bs-perf-row').length } : null;
  });
  const state = await gfxAll();
  results.panel = { ...shown, open: state.open, options: Object.keys(state.values).length };
  check(!!shown?.visible, 'F3 did not open the panel');
  check(shown?.rows === results.panel.options,
    `the panel shows ${shown?.rows} rows for ${results.panel.options} settings`);
  // NOT a modal, deliberately â€” see the note at the top of ui/perf-panel.ts.
  const before = await page.evaluate(() => window.__dbgPlayerPos());
  await page.keyboard.down('KeyW');
  await wait(900);
  await page.keyboard.up('KeyW');
  const after = await page.evaluate(() => window.__dbgPlayerPos());
  results.panel.heroTravelled = +Math.hypot(after.x - before.x, after.z - before.z).toFixed(2);
  check(results.panel.heroTravelled > 2,
    `the hero is frozen with the panel up (${results.panel.heroTravelled}) â€” it must NOT be a modal`);
  await wait(1500);
}

// ---------- each toggle actually removes work -------------------------------
// Ordered cheapest-to-restore first so a failure leaves the game in a sane
// state for the rows after it.
// `aa` is NOT in this list and cannot be: SMAA is three fullscreen quads, which
// is inside the frame-to-frame variance of the draw counter (a chunk finishing,
// a beast leaving the frustum). It is asserted as renderer state below with
// `shadows`, which has the same problem for a different reason.
// The thresholds are FLOORS, not the measured values, and bloom's is
// deliberately the loosest. Its cost is the number of glowing objects in frame,
// which is a property of where the hero happens to be standing: measured 23 near
// the spawn and 7 out by the gateway. The others scale with the chunk set, which
// is far steadier. A floor that only ever asks "did this do anything at all" is
// what a guard against a dead switch needs; the panel's own cost strings carry
// the representative numbers.
//
// `props` came down 40 -> 20 when core/shadow-cache.ts landed, and the reason is
// worth knowing rather than a loosened bolt. A tree used to be drawn four times
// a frame â€” the scene, the AO prepass, the bloom pass and the SHADOW pass â€” and
// the shadow one is now redrawn only when the cache goes stale, so switching
// trees off stops saving it every frame. Measured 30 and 40 on two runs of the
// same walk, against 70 before. Nothing else in the list moved: grass casts no
// shadow at all (props.ts sets castShadow false on the soft mesh), and AO and
// bloom are post passes the shadow map never touched.
for (const [id, minDrop] of [['ao', 40], ['bloom', 4], ['grass', 20], ['props', 20]]) {
  const on = await draws();
  await gfxSet(id, false);
  await wait(900);
  const off = await draws();
  await gfxSet(id, true);
  await wait(900);
  const back = await draws();
  results[id] = { drawsOn: on, drawsOff: off, drawsRestored: back, saved: on - off };
  check(on - off >= minDrop,
    `turning ${id} off saved ${on - off} draw calls, expected at least ${minDrop}`);
  // RELATIVE to the off-state, not back to the on-state. The absolute count
  // drifts while the streamer works â€” chunks arrive, chunks unload â€” so
  // "within 5% of where it started" fails on scene drift rather than on a
  // stuck switch (measured 488 -> 460 with nothing wrong). What the assertion
  // is actually for is "did turning it back on put the work back", and the
  // honest form of that is a comparison with the frame that had it off.
  check(back - off >= minDrop * 0.5,
    `turning ${id} back on put only ${back - off} draw calls back (removing it cost ${on - off})`);
}

// ---------- shadows and aa: state, because the frame cannot show them --------
// `shadows` renders into its own target, which three does not add to
// info.render.calls the way it adds scene draws; `aa` is three fullscreen quads,
// which is inside the counter's own frame-to-frame variance. Asserting a draw
// delta for either would be asserting noise, so these two are checked for
// round-tripping instead, and the file says so rather than inventing a number.
for (const id of ['shadows', 'aa']) {
  await gfxSet(id, false);
  await wait(1200);
  const off = await gfxGet(id);
  await gfxSet(id, true);
  await wait(1200);
  const on = await gfxGet(id);
  results[id] = { afterOff: off, afterOn: on };
  check(off === false, `${id} did not switch off`);
  check(on === true, `${id} did not come back on`);
}

// ---------- the frame cap is the one that changes HOW MANY frames -----------
{
  // OFF THE F2 READOUT, and counting rAF callbacks here instead was wrong in a
  // way worth recording: the cap does not skip CALLBACKS, it skips the work
  // inside them (see Engine.beginFrame), so requestAnimationFrame keeps firing
  // at the display's 165 Hz whatever the cap says â€” measured, a 30 fps cap
  // "read" 165.2. F2 counts RENDERED frames, which is the thing being capped.
  // The long wait is because that readout is a rolling mean of 120 of them: at
  // 30 fps the window takes four seconds to flush the old rate out.
  const fpsNow = async () => {
    await wait(7000);
    const m = /FPS\s+([\d.]+)/.exec(await overlay());
    return Number(m?.[1] ?? 0);
  };
  await gfxSet('fpsCap', 30);
  const at30 = await fpsNow();
  await gfxSet('fpsCap', 120);
  const at120 = await fpsNow();
  results.fpsCap = { at30, at120 };
  check(at30 > 20 && at30 < 40, `a 30 fps cap measured ${at30}`);
  check(at120 > at30 + 20, `raising the cap did not raise the frame rate (${at30} -> ${at120})`);
}

// ---------- and it STAYS off as you walk into unbuilt chunks ----------------
// The bug this exists for: grass switched off stayed off while standing still
// and came back in patches while walking. `buildStage` has two callers â€” the
// streamer's staged path and `buildChunk`'s build-it-all-now path â€” and only
// the first re-applied the setting, so every chunk that arrived through the
// other one arrived with its grass on. Standing still never builds a chunk,
// which is exactly why no earlier assertion here could see it.
{
  // A FRESH PAGE, and that is the whole reproduction rather than fussiness.
  //
  // The cause is the ZoneManager's gateway PRELOAD: within 30 units of a gate it
  // builds the destination, and to warm its shaders it hides the active world
  // and turns it back on â€” with a blanket `visible = true` that re-showed every
  // layer the panel had switched off. Reaching that needs the hero walking
  // toward the gate from the spawn. Two earlier versions of this section drove
  // the hero from wherever the previous assertions had left him, and both
  // passed against the broken build because `KeyW` follows the camera and the
  // camera had been turned. Measured on the broken build from a fresh page: 80
  // of 89 grass meshes came back on.
  //
  // IT STANDS THE HERO ON THE ROAD AND AIMS AT THE GATE rather than trusting
  // the boot's own heading, and that is a change of reasoning rather than of
  // code style. The version above said "the camera pointing the way a fresh
  // boot points it", which was true while a session opened on the road looking
  // down it. A session now opens INSIDE the walled camp with the camera on the
  // hero's face (World.playerStart), so a held W walks him into the huts, and
  // even aimed correctly a straight line out of a walled camp ends at the
  // palisade — measured, eight seconds closed 4.3 units of a 43.2-unit approach.
  // The gateway would never be reached, and this section would have gone on
  // PASSING, because grass switched off stays off when nothing ever preloads.
  // A reproduction whose setup is "whatever the game happens to do" is one that
  // stops reproducing silently, which is why `endedAtGateDist` is asserted below.
  //
  // Both the road and the bearing are ASKED FOR, not pinned, so a seed that
  // moved either moves this with it.
  const ctx = await browser.createBrowserContext();
  const fresh = await newPage(ctx, { width: 1280, height: 800 });
  await fresh.goto(`${HOST}/?menu=0&fs=0`, { waitUntil: 'load' });
  await fresh.waitForSelector('canvas');
  await wait(8000);
  await fresh.focus('canvas').catch(() => {});

  const road = await fresh.evaluate(() => window.__dbgTowns().spawn);
  await fresh.evaluate((s) => window.__dbgTp(s.x, s.z), road);
  await wait(600);
  const gateAt = await fresh.evaluate(() => {
    const g = window.__dbgZone().gate;
    const p = window.__dbgPlayerPos();
    return { bearing: Math.atan2(g.x - p.x, g.z - p.z), dist: Math.hypot(g.x - p.x, g.z - p.z) };
  });
  results.preloadWalk = { gateBearing: +gateAt.bearing.toFixed(3), gateDist: +gateAt.dist.toFixed(1) };
  await fresh.evaluate((b) => window.__dbgAim(b), gateAt.bearing);
  await wait(700);

  const freshLayers = () => fresh.evaluate(() => window.__dbgGfx().layers);
  await fresh.evaluate(() => window.__dbgGfx('grass', false));
  await wait(1500);
  const atRest = await freshLayers();

  await fresh.keyboard.down('KeyW');
  await wait(8000);
  await fresh.keyboard.up('KeyW');
  await wait(2000);
  const afterWalk = await freshLayers();
  // DID THE WALK ACTUALLY REACH THE THING BEING REPRODUCED? The preload arms
  // within PRELOAD_R (30) of the gateway, and every assertion below passes
  // vacuously if it never armed — grass switched off stays off when nothing
  // hides and re-shows the world. This is the assertion that makes the rest of
  // the section mean something, and it is the one that would have caught the
  // spawn moving out from under it.
  results.preloadWalk.endedAtGateDist = await fresh.evaluate(() => {
    const g = window.__dbgZone().gate;
    const p = window.__dbgPlayerPos();
    return +Math.hypot(g.x - p.x, g.z - p.z).toFixed(1);
  });
  await ctx.close();

  check(results.preloadWalk.endedAtGateDist < 30,
    `the walk never reached the gateway preload (${results.preloadWalk.endedAtGateDist} away, `
    + `from ${results.preloadWalk.gateDist}) â€” everything below would pass vacuously`);

  results.stillOffAfterWalking = {
    atRest: { grass: atRest.grass, terrain: atRest.terrain },
    afterWalk: { grass: afterWalk.grass, terrain: afterWalk.terrain },
  };
  check(atRest.grass.shown === 0,
    `grass did not go off at all (${atRest.grass.shown} visible)`);
  check(atRest.grass.hidden > 0, 'no grass meshes to hide â€” the world had not streamed');
  check(afterWalk.grass.shown === 0,
    `${afterWalk.grass.shown} grass meshes came back while walking `
    + `(${afterWalk.grass.hidden} still hidden)`);
  // AND THE GROUND IS STILL THERE. Hiding one layer must not take anything
  // else with it, and the first fix for the grass did exactly that: it assigned
  // visibility only to the layers it recognised, so after a gateway preload
  // hid the world the terrain was never turned back on and the player got sky
  // and nothing else. Asserting only the thing you changed is how a fix ships a
  // worse bug than the one it closed.
  for (const [when, snap] of [['at rest', atRest], ['after walking', afterWalk]]) {
    check(snap.terrain.hidden === 0 && snap.terrain.shown > 0,
      `${when}, ${snap.terrain.hidden} terrain chunks are INVISIBLE `
      + `(${snap.terrain.shown} visible) â€” hiding grass took the ground with it`);
    check(snap.water.hidden === 0,
      `${when}, ${snap.water.hidden} water meshes are invisible though water is on`);
  }
  await gfxSet('grass', true);
  await wait(900);
}

// ---------- it is remembered across a reload --------------------------------
{
  await gfxSet('bloom', false);
  await gfxSet('fpsCap', 60);
  await wait(500);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await wait(8000);
  const after = (await gfxAll()).values;
  results.persisted = { bloom: after.bloom, fpsCap: after.fpsCap };
  check(after.bloom === false, 'bloom=off was not remembered across a reload');
  check(after.fpsCap === 60, `fpsCap=60 was not remembered (got ${after.fpsCap})`);
}

// ---------- and the console can set them ------------------------------------
{
  await page.keyboard.press('Backquote');
  await page.waitForSelector('.bs-console-input', { visible: true });
  await page.type('.bs-console-input', '/gfx bloom on');
  await page.keyboard.press('Enter');
  await wait(400);
  await page.keyboard.press('Backquote');
  await wait(400);
  const v = await gfxGet('bloom');
  results.console = { bloomAfterCommand: v };
  check(v === true, `/gfx bloom on did not take (${v})`);
}

// ---------- the SETTINGS panel drives the same switches ---------------------
// The Graphics tab of the in-game menu (ui/settings.ts) offers five of these
// rows to a player who will never press F3. It is not a second implementation —
// same model, same keys — but "not a second implementation" is exactly the
// claim, and the way it fails is the way every settings panel fails: the row
// renders, the pill flips, the key is written, and the renderer never hears.
//
// So it is judged the way every row above is judged, by what the FRAME does,
// and driven through the real buttons rather than through `__dbgGfx`. AO is the
// one used because it is the largest and steadiest of the five (47 draws; the
// floor here is the same 40 the F3 arm uses).
//
// The pause menu is a MODAL — the hero is frozen while it is up — which is
// helpful rather than awkward: nothing is walking into new chunks between the
// two readings, so the draw count is as still as it ever gets.
{
  // F10, not Escape: the in-game menu moved off a key the browser spends on
  // fullscreen and pointer lock before the page sees it.
  await page.keyboard.press('F10');
  await wait(500);
  await page.evaluate(() => document.querySelector('.bs-pause [data-act="settings"]')?.click());
  await wait(300);
  await page.evaluate(() => document.querySelector('.bs-pause [data-tab="graphics"]')?.click());
  await wait(300);
  const row = () => page.evaluate(() => {
    const b = document.querySelector('.bs-pause [data-gfx="ao"]');
    return b && { pressed: b.getAttribute('aria-pressed'), pill: b.querySelector('.pill')?.textContent };
  });
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.bs-pause [data-gfx]')].map((b) => b.getAttribute('data-gfx')));
  const on = await draws();
  await page.evaluate(() => document.querySelector('.bs-pause [data-gfx="ao"]')?.click());
  await wait(900);
  const off = await draws();
  const rowOff = await row();
  const flagOff = await gfxGet('ao');
  await page.evaluate(() => document.querySelector('.bs-pause [data-gfx="ao"]')?.click());
  await wait(900);
  const back = await draws();
  await page.evaluate(() => document.querySelector('.bs-pause [data-act="continue"]')?.click());
  await wait(500);

  results.settingsPanel = { rows, drawsOn: on, drawsOff: off, drawsRestored: back,
    saved: on - off, rowAfterOff: rowOff, gfxAfterOff: flagOff };
  check(rows.length === 5, `the Graphics tab shows ${rows.length} rows, expected 5`);
  check(on - off >= 40,
    `the settings panel's AO row saved ${on - off} draw calls, expected at least 40`);
  check(back - off >= 20,
    `turning it back on from the panel put only ${back - off} draw calls back`);
  // The row and the model have to agree, or the two panels drift: F3 would show
  // one thing and Settings another, both of them "working".
  check(flagOff === false, `__dbgGfx says ao is ${flagOff} after the settings row turned it off`);
  check(rowOff?.pressed === 'false', `the row still reads aria-pressed=${rowOff?.pressed}`);
}

// ---------- and nothing is painted through it -------------------------------
// Issue #41. The three developer instruments all claim the top of the screen â€”
// the console is a full-width sheet down the top 42vh, F3 sits top-left and F2
// top-centre â€” so at the console's old z-index of 9000 both panels were drawn
// straight through its log and through the line you were typing.
//
// F3 is judged by a HIT TEST rather than by reading a z-index back, because
// elementFromPoint answers out of the same stacking computation the compositor
// paints from: it is the browser's opinion about what is on top, where
// getComputedStyle('zIndex') would only be our own assignment handed back.
// F2 CANNOT be judged that way and the number below says so instead of
// pretending otherwise â€” it is pointer-events:none, so a hit test falls through
// it whichever way round the two are stacked. Comparing the computed values is
// the strongest thing available there, and it still catches the case that
// matters: a panel authored above the console (F2's is an inline style in
// core/debug-overlay.ts, nowhere near the stylesheet the console's lives in).
{
  await page.keyboard.press('F3');
  await wait(400);
  await page.keyboard.press('Backquote');
  await page.waitForSelector('.bs-console-input', { visible: true });
  await wait(400);
  const stack = await page.evaluate(() => {
    const con = document.querySelector('.bs-console');
    const perf = document.querySelector('.bs-perf');
    const f2 = [...document.body.children].find(
      (c) => c instanceof HTMLDivElement && (c.textContent || '').startsWith('FPS'));
    const c = con.getBoundingClientRect();
    const p = perf.getBoundingClientRect();
    const l = Math.max(c.left, p.left), r = Math.min(c.right, p.right);
    const t = Math.max(c.top, p.top), b = Math.min(c.bottom, p.bottom);
    // The centre of the OVERLAP, so the sample is inside both by construction
    // rather than by a coordinate written down here that a layout change would
    // quietly move off one of them.
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
  results.stacking = stack;
  // Vacuous otherwise: if the two do not overlap there is nothing to be on top of.
  check(stack.overlap > 1000,
    `the F3 panel and the console overlap by only ${stack.overlap}pxÂ² â€” nothing was tested`);
  check(stack.onTop === 'console',
    `the console is under the F3 panel at ${stack.sample} (hit "${stack.onTop}")`);
  check(stack.z.overlay !== null, 'the F2 overlay was not found â€” ?debug=1 should have it up');
  check(stack.z.console > stack.z.overlay,
    `the console (${stack.z.console}) is below the F2 overlay (${stack.z.overlay})`);
  await page.keyboard.press('Backquote');
  await page.keyboard.press('F3');
  await wait(300);
}

// ---------- what is allowed to CAST ambient occlusion -----------------------
// Issue #39: the grass carpet and the cloud deck were opaque, wrote depth, and
// were therefore in the AO G-buffer â€” where a half-res horizon search over
// sub-pixel blade billboards printed a mottled grey smear across the meadow
// around every hedge clump, and a 1.8-unit contact radius on a cumulus printed
// dotted black dashes down every crease where two puffs meet.
//
// The frame is asked, not the flag. `?aoview=1` renders the denoised AO buffer
// straight to screen, so both halves are a picture of the AO and nothing else.
//
// TWO PAGES IS NOT AN OPTION FOR THE GRASS HALF. Two separate loads of the same
// framing differ by 2.02 code values everywhere from streaming and settling
// alone, which is larger than the artefact â€” so the A/B is two screenshots of
// ONE page with `__dbgGfx` between them, and the frames then differ by exactly
// the layer that was toggled.
//
// The `props` arm is the CONTROL and it is not optional: without it, a capture
// that silently returned the same bytes twice would pass the grass assertion
// perfectly. Trees, rocks and huts are the solid prop mesh, they are still
// occluders, and hiding them MUST move the AO buffer.
{
  const ctx = await browser.createBrowserContext();
  const shot = await newPage(ctx, { width: 900, height: 620 });
  const decode = async () => {
    // Buffer.from, because puppeteer hands back a plain Uint8Array and pngjs
    // reaches straight for Buffer's readUInt32BE.
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

  // A meadow of terraces carrying both kinds of prop, chosen because BOTH arms
  // have to work in one framing: grass everywhere for the assertion, and trees
  // and boulders in the same frame for the control. The tighter framing the
  // issue's first screenshot is of moves the control to 0.49, which is too
  // near the noise to prove anything.
  await shot.goto(
    `${HOST}/?${AOVIEW}&cam=12,4.5,4&look=20,2,-2`, { waitUntil: 'load' });
  await shot.waitForSelector('canvas');
  await wait(6000);
  const withAll = await decode();
  await shot.evaluate(() => window.__dbgGfx('grass', false));
  await wait(1500);
  const withoutGrass = await decode();
  await shot.evaluate(() => { window.__dbgGfx('grass', true); window.__dbgGfx('props', false); });
  await wait(1500);
  const withoutProps = await decode();
  await shot.evaluate(() => window.__dbgGfx('props', true));

  // Clouds: above the deck, where the frame is nothing but cumulus. Excluded,
  // every one of those pixels is untouched white.
  await shot.goto(
    `${HOST}/?${AOVIEW}&cam=0,120,0&look=80,115,40`, { waitUntil: 'load' });
  await shot.waitForSelector('canvas');
  await wait(6000);
  const sky = await decode();
  let dark = 0;
  for (const v of sky) if (v < 245) dark++;
  await ctx.close();

  const ao = {
    grassMovesAo: meanAbsDiff(withAll, withoutGrass),
    propsMovesAo: meanAbsDiff(withAll, withoutProps),
    cloudPixelsOccluded: +(100 * dark / sky.length).toFixed(3),
  };
  results.aoOccluders = ao;
  // 0.10 of a code value today against 16.30 on the build that shipped the bug,
  // so the threshold is nowhere near either. It is not zero and should not be:
  // hiding grass also UNCOVERS the terrain behind it, and that terrain has AO
  // of its own. That confound is why the framing matters â€” the same pair reads
  // 1.72 from the spawn, where grass fills a third of the frame.
  check(ao.grassMovesAo < 1,
    `hiding grass moved the AO buffer by ${ao.grassMovesAo} code values â€” `
    + 'the grass carpet is still an AO occluder');
  // 7.08 today, 5.96 before â€” the control is a little STRONGER now, because a
  // tree's contact ring is no longer competing with a grey smear.
  check(ao.propsMovesAo > 3,
    `hiding props moved the AO buffer by only ${ao.propsMovesAo} â€” the control `
    + 'failed, so the grass measurement above proves nothing');
  // 0.034% today, and it is the horizon haze at the frame's rim rather than any
  // cloud; 13.98% on the build that shipped the bug, which is the crease dashes.
  check(ao.cloudPixelsOccluded < 2,
    `${ao.cloudPixelsOccluded}% of a sky full of cumulus is ambient-occluded â€” `
    + 'the cloud deck is still an AO occluder');
}

// Leave the profile as we found it, so a later run does not inherit a
// half-disabled renderer from this one.
await page.evaluate(() => {
  for (const k of Object.keys(window.__dbgGfx().values)) {
    window.localStorage.removeItem(`game.settings.graphics.${k}`);
  }
});

console.log(JSON.stringify({ ...results, failures: fails, pass: fails.length === 0 }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
