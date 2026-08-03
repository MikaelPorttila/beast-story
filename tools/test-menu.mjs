// The start-menu guard: does the title screen actually GATE the game?
//
// Four claims, and each is checked by driving the menu rather than by reading a
// flag off it:
//
//   1. THE POSTER IS FIRST. It has to be on screen within a fraction of a second
//      of load, before the world is built — `menuShownAtMs`. This is the whole
//      of issue #13: the game used to be assembled inside one unbroken 14.7 s
//      task and the player watched a black page for all of it.
//   2. NOTHING RUNS BEHIND IT. `playingBehindMenu` must be false — the frame
//      loop is not started until New Game — and the hero cannot move: holding W
//      for a second with the poster on screen must leave __dbgPlayerPos where it
//      was, while the same hold after New Game must move him. That pair is the
//      point; a menu that renders but does not gate is worse than no menu.
//   3. THE WAIT IS REPORTED AND THEN OVER. The boot chip counts through its four
//      phases (`bootStages`) and finishes at 100%, and New Game raises the
//      full-screen loading cover rather than dropping the player into a
//      half-built world.
//   4. "Press start" takes ANY key, the steps advance in order, and `menu=0`
//      removes the screen entirely — which is what every other tool relies on.
//   5. THE CURSOR IS VISIBLE WHEREVER IT IS. Every option the focus lands on has
//      to draw the ring — `ringOn*.ring`, all true. This is issue #19, and it
//      was only ever wrong on ONE button: `.bs-menu-btn.primary` restated
//      `box-shadow` one rule below `:focus-visible` at equal specificity, so New
//      Game — the entry a pad player lands on first, where the ring is the only
//      thing saying where they are — was the single option that did not light
//      up. Reading the COMPUTED shadow is the point: the rule was there and the
//      class was on the element the whole time, and only the resolved value
//      shows the cascade eating it.
//
// It also reports the art's decoded size, because a 404 on either image leaves
// a menu that is technically present and visually empty.
//
//   bun tools/test-menu.mjs
import { launchBrowser, newPage, newContextPage, wait, logPageErrors } from './browser.mjs';
import { BASE as HOST } from './target.mjs';

const HOLD = 1200;   // long enough that a walking hero clears the noise floor
/**
 * How long to let the boot sequence run before giving up on it, in ms.
 *
 * Generous on purpose: the shader warm-up sweep is the long pole and it is
 * driver-bound, measured at 13.5 s on a headless RTX 3070 Ti. The probe waits
 * for the real signal (`__dbgBoot().prepDone`) rather than for a fixed BOOT
 * interval, because a fixed one is either a lie on a slow host or dead time on
 * a fast one.
 */
const PREP_TIMEOUT = 60000;

const state = (page) => page.evaluate(() => {
  const m = document.querySelector('.bs-menu');
  const art = document.querySelector('.bs-menu .art');
  const logo = document.querySelector('.bs-menu .logo');
  const vis = m ? Number(getComputedStyle(m).opacity) : 0;
  return {
    present: !!m,
    visible: vis > 0.5,
    step: m?.getAttribute('data-step') ?? null,
    art: art?.naturalWidth ?? 0,
    logo: logo?.naturalWidth ?? 0,
    buttons: [...document.querySelectorAll('.bs-menu .panel button')]
      .map((b) => b.dataset.act ?? b.dataset.toggle ?? b.dataset.lang ?? '?'),
    fullscreen: !!(document.fullscreenElement ?? document.webkitFullscreenElement),
  };
});

const pos = (page) => page.evaluate(() => window.__dbgPlayerPos());

/** The boot sequence's own account of itself. See __dbgBoot in src/main.ts. */
const boot = (page) => page.evaluate(() => window.__dbgBoot?.() ?? null);

/** The progress indicator: which face it is wearing, and what it says. */
const loader = (page) => page.evaluate(() => {
  const el = document.querySelector('.bs-load');
  if (!el) return null;
  return {
    chip: el.classList.contains('chip'),
    cover: el.classList.contains('cover'),
    label: el.querySelector('.lbl')?.textContent ?? null,
    pct: el.querySelector('.pct')?.textContent ?? null,
    opacity: Number(getComputedStyle(el).opacity).toFixed(2),
  };
});

/**
 * Rendered frames per second, read off the F2 overlay — the same readout
 * tools/test-f2.mjs asserts on, and the only place the game states its own
 * measured frame rate. NOT a requestAnimationFrame count: rAF fires at the
 * display's refresh rate whether or not the engine drew anything, so it reports
 * 165 on a 165 Hz panel no matter what the cap is set to.
 *
 * There is no longer a behind-the-menu figure to compare it against, and its
 * absence IS the fix: the loop used to run behind the poster at a 20 fps cap
 * (96.9% of the main thread uncapped, 27% capped) and now does not run at all,
 * so the overlay has nothing to average. `playingBehindMenu` is the assertion
 * that replaced that pair — see the header.
 */
const renderedFps = (page) => page.evaluate(() => {
  const el = [...document.body.children].find(
    (c) => c instanceof HTMLDivElement && (c.textContent || '').startsWith('FPS'),
  );
  const m = el && /([\d.]+)/.exec(el.textContent || '');
  return m ? Number(m[1]) : null;
});
const moved = (a, b) => +Math.hypot(b.x - a.x, b.z - a.z).toFixed(2);

/**
 * The focus ring, read off whichever button the cursor is standing on.
 *
 * `ring` is derived from the COMPUTED box-shadow rather than from the presence
 * of a rule, because the bug it guards against (issue #19) was a rule that
 * existed, matched, and lost the cascade — nothing short of the resolved value
 * can tell that apart from a working ring.
 *
 * The test for one is SPREAD. Every resting shadow on this screen is a drop
 * shadow or an inset highlight, all blur and zero spread; a ring is the one
 * thing drawn as `0 0 0 Npx`, an offsetless, blurless band N pixels wide. So a
 * non-zero fourth length is the ring and cannot be anything else — which also
 * means this keeps working if the ring is restyled, as long as it stays a ring.
 */
const focusRing = (page) => page.evaluate(() => {
  const a = document.activeElement;
  if (!a || !a.classList.contains('bs-menu-btn')) return null;
  const shadow = getComputedStyle(a).boxShadow;
  return {
    on: a.dataset.act ?? a.dataset.toggle ?? a.dataset.lang ?? '?',
    variant: a.className.replace('bs-menu-btn', '').trim() || 'plain',
    ring: /\b0px 0px 0px [1-9]\d*px/.test(shadow),
    shadow,
  };
});

/** Poll until the boot sequence says everything is built. Returns how long. */
async function waitForPrep(page) {
  const t0 = Date.now();
  while (Date.now() - t0 < PREP_TIMEOUT) {
    // page.evaluate queues behind whatever phase is holding the main thread, so
    // this polls far more slowly than the interval suggests. That is fine: the
    // answer is still the first one available after the work finishes.
    if ((await boot(page))?.prepDone) return Date.now() - t0;
    await wait(250);
  }
  return -1;
}

/** Hold W for `ms` and report how far the hero travelled. */
async function walk(page, ms) {
  const before = await pos(page);
  await page.keyboard.down('KeyW');
  await wait(ms);
  await page.keyboard.up('KeyW');
  await wait(120);
  return moved(before, await pos(page));
}

const browser = await launchBrowser();
const out = {};

// ---- desktop: gate, then release ------------------------------------------
{
  const { ctx, page } = await newContextPage(browser, { width: 1000, height: 640 });
  logPageErrors(page);
  // NO fps= here, deliberately. The claim being tested is that the title screen
  // stands the renderer DOWN while it covers the game and hands it back on the
  // way out, and an explicit cap would flatten both halves of that into one
  // number. `debug=1` opens the F2 overlay, which is where the measured rate is
  // published.
  // fs=0 because this run CLICKS New Game, and the game now takes fullscreen
  // from that gesture — which resizes the viewport out from under the walk
  // being measured two lines later. The override never writes the preference
  // back; see core/flags.ts.
  // Stamped from inside the page, before the app module runs: the ONE number
  // issue #13 is about. It has to be a fraction of a second, and it has to stay
  // that way whatever the world costs to build.
  await page.evaluateOnNewDocument(() => {
    window.__menuAt = null;
    const iv = setInterval(() => {
      if (document.querySelector('.bs-menu.show')) {
        window.__menuAt = Math.round(performance.now());
        clearInterval(iv);
      }
    }, 8);
  });
  await page.goto(`${HOST}/?debug=1&fs=0`, { waitUntil: 'load' });
  await page.waitForSelector('.bs-menu');
  out.menuShownAtMs = await page.evaluate(() => window.__menuAt);
  // The chip is up and counting while the world is still being cut.
  out.loaderWhileBuilding = await loader(page);

  out.prepTookMs = await waitForPrep(page);
  out.bootStages = (await boot(page))?.stages ?? null;
  out.loaderWhenReady = await loader(page);

  out.atBoot = await state(page);
  // The half of the old MENU_FPS pair that survived, in a stronger form: there
  // is no frame loop behind the poster to measure.
  out.playingBehindMenu = (await boot(page))?.playing ?? null;
  out.walkedBehindMenu = await walk(page, HOLD);

  // "Press start" takes any key — this one is neither Enter nor Space.
  await page.keyboard.press('KeyK');
  await wait(400);
  out.afterAnyKey = await state(page);
  // The cursor is on New Game the moment the options appear, and it is the ONE
  // place on this screen where a player never chose to be — so it is also the
  // one that has to look chosen. See claim 5 in the header.
  out.ringOnNewGame = await focusRing(page);
  // There is NO fullscreen step any more: any key goes straight to the options,
  // and the game takes fullscreen itself when New Game is pressed. Nothing
  // should have been left behind on the way.
  out.noPillLeftBehind = await page.evaluate(() =>
    document.querySelector('.bs-fsprompt') === null);

  // Into Settings and back out, which is also the language picker's home.
  // ONE ArrowDown, not two: Load is disabled, and a disabled button is not in
  // the focus ring — so the list the arrows walk is [New Game, Settings]. Two
  // presses would wrap back to New Game and start the game instead, which is
  // exactly what this probe caught the first time it ran.
  await page.keyboard.press('ArrowDown');
  // The comparison the issue was reported as: the wooden button beside the gold
  // one, on the same screen, one keypress apart. Settings was always right, and
  // that is what made New Game look like the bug it was.
  out.ringOnSettings = await focusRing(page);
  await page.keyboard.press('Enter');
  await wait(400);
  out.settings = await state(page);
  // A settings row and a language chip: the other two button shapes, and the
  // chip is the second GOLD face on this screen, so it takes the same ring New
  // Game does rather than the gold-on-gold one.
  out.ringOnSettingsRow = await focusRing(page);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await wait(200);
  out.ringOnLangChip = await focusRing(page);
  // The switch that replaced the question: present, and ON by default.
  out.autoFullscreenRow = await page.evaluate(() => {
    const b = document.querySelector('.bs-menu [data-toggle="autoFullscreen"]');
    return b ? b.getAttribute('aria-pressed') : null;
  });
  // The language picker, live: switching to Swedish has to re-caption the menu
  // under the player without reloading. `menu.newGame` is 'Nytt spel' in sv.ts.
  out.langButtons = await page.evaluate(() =>
    [...document.querySelectorAll('.bs-menu [data-lang]')].map((b) => b.dataset.lang));
  await page.click('.bs-menu [data-lang="sv"]');
  await wait(300);
  await page.click('.bs-menu [data-act="back"]');
  await wait(400);
  out.optionsInSwedish = await page.evaluate(() =>
    [...document.querySelectorAll('.bs-menu .panel button')].map((b) => b.textContent.trim()));
  await page.click('.bs-menu [data-act="settings"]');
  await wait(300);
  await page.click('.bs-menu [data-lang="en"]');
  await wait(300);

  // Escape backs out of Settings, and has to land the cursor on the entry that
  // opened it rather than at the top of the list.
  await page.keyboard.press('Escape');
  await wait(400);
  out.afterEscape = await state(page);
  out.focusAfterEscape = await page.evaluate(() =>
    document.activeElement?.dataset?.act ?? null);

  // The handover, sampled from INSIDE the page at 25 ms. It has to be: a probe
  // that asks from outside pays a round trip per sample and lands well after the
  // half-second dissolve it is trying to watch — the first attempt read the
  // cover already at 0.60 and fading and could not tell that from a bug.
  await page.evaluate(() => {
    window.__hand = [];
    const iv = setInterval(() => {
      const menu = document.querySelector('.bs-menu');
      const el = document.querySelector('.bs-load');
      window.__hand.push({
        t: Math.round(performance.now()),
        menu: menu ? Number(getComputedStyle(menu).opacity).toFixed(2) : null,
        face: el ? (el.classList.contains('cover') ? 'cover' : 'chip') : null,
        load: el ? Number(getComputedStyle(el).opacity).toFixed(2) : null,
      });
      if (window.__hand.length > 120) clearInterval(iv);
    }, 25);
  });
  // New Game, clicked rather than Entered: this assertion is about the poster
  // going away and the hero waking up, not about where the cursor was.
  await page.click('.bs-menu [data-act="new"]');
  await wait(2000);
  // What the poster dissolved INTO. `coverFullyUpWhileMenuVisible` is the claim:
  // there was a moment where the loading screen was opaque and the menu was
  // still on top of it, fading — which is the z-index inversion in
  // LoadingScreen.cover doing its job. `menuFadeMs` is how long the poster
  // lasted; it must be the half second the CSS asks for, not the 140 ms a
  // bubbled button transition used to cut it to.
  out.handover = await page.evaluate(() => {
    const h = window.__hand;
    const fadeStart = h.find((s) => s.menu !== null && Number(s.menu) < 0.99);
    const lastMenu = [...h].reverse().find((s) => s.menu !== null);
    return {
      coverFullyUpWhileMenuVisible:
        h.some((s) => s.menu !== null && s.face === 'cover' && Number(s.load) > 0.95),
      menuFadeMs: fadeStart && lastMenu ? lastMenu.t - fadeStart.t : -1,
      trace: h.filter((s) => s.menu !== null || s.face !== null)
        .map((s) => `${s.t} menu=${s.menu} ${s.face}=${s.load}`).slice(0, 40),
    };
  });
  await wait(200);
  out.afterStart = await state(page);
  // ...and gone again once there is a game to look at.
  out.loaderAfterStart = await loader(page);
  // The welcome toast MOVED — it used to be emitted at load, which behind a
  // poster would have expired before the player ever saw the game, so it is
  // fired from the menu's onStart instead. Read straight after starting,
  // before its ~4 s life runs out.
  out.welcomeToast = await page.evaluate(() =>
    document.querySelector('.bs-toasts')?.textContent?.trim() || null);
  // The renderer is now running at whatever rate this load asked for — no cap
  // was ever imposed, so there is nothing to have failed to restore. The number
  // is still reported because it is the only proof the loop is alive at all,
  // and it must be paired with `playingBehindMenu: false` above.
  await wait(1500);   // the readout averages over ~120 frames
  out.fpsAfterStart = await renderedFps(page);
  out.playingAfterStart = (await boot(page))?.playing ?? null;
  out.walkedAfterStart = await walk(page, HOLD);
  await ctx.close();
}

// ---- phone: the poster, and the chip that fits beside the notch -------------
{
  const { ctx, page } = await newContextPage(browser, {
    width: 844, height: 390, phone: true,
  });
  logPageErrors(page);
  await page.goto(`${HOST}/?fps=30`, { waitUntil: 'load' });
  await page.waitForSelector('.bs-menu');
  out.phoneAtBoot = await state(page);
  out.phoneLoader = await loader(page);
  await waitForPrep(page);
  await page.tap('.bs-menu');
  await wait(500);
  out.phoneAfterTap = await state(page);
  await ctx.close();
}

// ---- menu=0: what every other tool in here passes ---------------------------
// No poster, so no staged boot and no progress indicator: the module runs
// straight through and the game is playing by the time the probe looks, exactly
// as it did before any of this. `loaderOff` being null is that claim.
{
  const page = await newPage(browser, { width: 900, height: 600 });
  logPageErrors(page);
  await page.goto(`${HOST}/?fps=30&menu=0`, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  out.loaderOff = await loader(page);
  out.playingWithMenuOff = (await boot(page))?.playing ?? null;
  out.menuOff = await state(page);
  out.walkedWithMenuOff = await walk(page, HOLD);
}

// ---- the entrance: logo, then painting, then "press start" ------------------
// Issue #49. The claim is an ORDER, and the only honest way to read an order off
// a screen that assembles itself in 1.7 s is to stop the clock and step through
// it: the probe waits for `.bs-menu.intro`, PAUSES the animations it finds and
// scrubs them to three moments, reading the computed opacity of each layer.
//
// Scrubbing rather than sampling in real time, because a real-time sample of
// this is not available on this page at all. The boot's phases are long tasks —
// a screenshot asked for at 1200 ms was delivered at 5695 ms — so every
// wall-clock reading lands after the sequence is over. That same fact is why the
// beats are CSS in the first place (a `setTimeout(550)` for the second one fired
// at 4066 ms), and it is why `animations` is asserted to be non-empty: an
// entrance rebuilt on timers would leave nothing here to scrub, and would fail
// on that line rather than on a subtle one.
//
// `photoIsLit` is the other half. A staged capture pauses every animation on the
// poster, so a sequence that ran under photo=1 would freeze the still half-lit —
// menu.ts jumps straight to the end state there, and this is that claim.
{
  const { ctx, page } = await newContextPage(browser, { width: 1000, height: 640 });
  logPageErrors(page);
  await page.goto('http://localhost:5187/?fs=0', { waitUntil: 'load' });
  await page.waitForSelector('.bs-menu.intro', { timeout: 15000 });
  const layers = await page.evaluate(() => {
    window.__intro = document.getAnimations().filter(
      (a) => a.animationName === 'bsIntroIn' || a.animationName === 'bsPressPulse');
    window.__intro.forEach((a) => a.pause());
    return window.__intro.map((a) => `${a.effect.target.className}:${a.animationName}`);
  });
  const at = async (ms) => {
    await page.evaluate((t) => window.__intro.forEach((a) => { a.currentTime = t; }), ms);
    return page.evaluate(() => {
      const m = document.querySelector('.bs-menu');
      const o = (s) => Number(getComputedStyle(m.querySelector(s)).opacity).toFixed(2);
      return { logo: o('.logo'), art: o('.stage'), press: o('.press') };
    });
  };
  out.intro = {
    animations: layers,
    // Mid-first-beat: the wordmark is arriving and nothing else is on screen.
    at300: await at(300),
    // Mid-second: the painting is coming up under a logo that is already full.
    at1000: await at(1000),
    // After the third: everything up, and the words have started breathing.
    at1900: await at(1900),
  };
  await ctx.close();
}
{
  const page = await newPage(browser, { width: 1000, height: 640 });
  logPageErrors(page);
  await page.goto('http://localhost:5187/?photo=1&menu=1', { waitUntil: 'load' });
  await page.waitForSelector('.bs-menu');
  await wait(600);
  out.photoIsLit = await page.evaluate(() => {
    const m = document.querySelector('.bs-menu');
    const o = (s) => Number(getComputedStyle(m.querySelector(s)).opacity).toFixed(2);
    return { lit: m.classList.contains('lit'), intro: m.classList.contains('intro'),
      logo: o('.logo'), art: o('.stage'), press: o('.press') };
  });
}

console.log(JSON.stringify(out, null, 2));
await browser.close();
