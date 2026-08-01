// The start-menu guard: does the title screen actually GATE the game?
//
// Three claims, and each is checked by driving the menu rather than by reading
// a flag off it:
//
//   1. It is up at boot and the hero cannot move behind it. Holding W for a
//      second with the poster on screen must leave __dbgPlayerPos where it was;
//      the same hold after New Game must move him. That pair is the whole point
//      — a menu that renders but does not gate is worse than no menu.
//   2. "Press start" takes ANY key, and the steps advance in order: press ->
//      options on a desktop, press -> fullscreen -> options on a phone.
//   3. `menu=0` removes it, which is what every other tool in here relies on.
//
// It also reports the art's decoded size, because a 404 on either image leaves
// a menu that is technically present and visually empty.
//
//   bun tools/test-menu.mjs
import { launchBrowser, newPage, newContextPage, wait, logPageErrors } from './browser.mjs';

const BOOT = 3000;   // world build + first chunks
const HOLD = 1200;   // long enough that a walking hero clears the noise floor

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
    fsPill: !!document.querySelector('.bs-fsprompt'),
  };
});

const pos = (page) => page.evaluate(() => window.__dbgPlayerPos());

/**
 * Rendered frames per second, read off the F2 overlay — the same readout
 * tools/test-f2.mjs asserts on, and the only place the game states its own
 * measured frame rate. NOT a requestAnimationFrame count: rAF fires at the
 * display's refresh rate whether or not the engine drew anything, so it reports
 * 165 on a 165 Hz panel no matter what the cap is set to.
 */
const renderedFps = (page) => page.evaluate(() => {
  const el = [...document.body.children].find(
    (c) => c instanceof HTMLDivElement && (c.textContent || '').startsWith('FPS'),
  );
  const m = el && /([\d.]+)/.exec(el.textContent || '');
  return m ? Number(m[1]) : null;
});
const moved = (a, b) => +Math.hypot(b.x - a.x, b.z - a.z).toFixed(2);

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
  await page.goto('http://localhost:5187/?debug=1', { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await wait(BOOT);

  out.atBoot = await state(page);
  out.fpsBehindMenu = await renderedFps(page);
  out.walkedBehindMenu = await walk(page, HOLD);

  // "Press start" takes any key — this one is neither Enter nor Space.
  await page.keyboard.press('KeyK');
  await wait(400);
  out.afterAnyKey = await state(page);
  // The fullscreen question is step two on EVERY device that can honour the
  // answer, desktop included, and it has to be answerable from the keyboard:
  // the pill's buttons join the menu's focus ring, so Enter lands on one.
  out.focusOnFsStep = await page.evaluate(() =>
    document.activeElement?.className ?? null);
  await page.keyboard.press('ArrowLeft');       // YES -> NO
  await wait(150);
  out.focusAfterArrow = await page.evaluate(() =>
    document.activeElement?.className ?? null);
  await page.keyboard.press('Enter');           // answer NO, on to the options
  await wait(500);
  out.afterFullscreenAnswer = await state(page);

  // Into Settings and back out, which is also the language picker's home.
  // ONE ArrowDown, not two: Load is disabled, and a disabled button is not in
  // the focus ring — so the list the arrows walk is [New Game, Settings]. Two
  // presses would wrap back to New Game and start the game instead, which is
  // exactly what this probe caught the first time it ran.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await wait(400);
  out.settings = await state(page);
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

  // New Game, clicked rather than Entered: this assertion is about the poster
  // going away and the hero waking up, not about where the cursor was.
  await page.click('.bs-menu [data-act="new"]');
  await wait(1200);
  out.afterStart = await state(page);
  // The welcome toast MOVED — it used to be emitted at load, which behind a
  // poster would have expired before the player ever saw the game, so it is
  // fired from the menu's onStart instead. Read straight after starting,
  // before its ~4 s life runs out.
  out.welcomeToast = await page.evaluate(() =>
    document.querySelector('.bs-toasts')?.textContent?.trim() || null);
  // The other half of the cap claim. `fpsBehindMenu` should be ~20 and this
  // should be well clear of it — a run where both are 20 means the restore on
  // the way out was lost and the game is stuck at menu speed forever, which is
  // a far worse bug than the one the cap was added to fix.
  await wait(1500);   // the readout averages, so let it forget the capped frames
  out.fpsAfterStart = await renderedFps(page);
  out.walkedAfterStart = await walk(page, HOLD);
  await ctx.close();
}

// ---- phone: the fullscreen question is step two ----------------------------
{
  const { ctx, page } = await newContextPage(browser, {
    width: 844, height: 390, phone: true,
  });
  logPageErrors(page);
  await page.goto('http://localhost:5187/?fps=30', { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await wait(BOOT);
  out.phoneAtBoot = await state(page);
  await page.tap('.bs-menu');
  await wait(500);
  out.phoneAfterTap = await state(page);
  // Answering it — either button — has to hand the player on to the options.
  const no = await page.$('.bs-fs-btn.no');
  if (no) await no.click();
  await wait(500);
  out.phoneAfterAnswer = await state(page);
  await ctx.close();
}

// ---- menu=0: what every other tool in here passes ---------------------------
{
  const page = await newPage(browser, { width: 900, height: 600 });
  logPageErrors(page);
  await page.goto('http://localhost:5187/?fps=30&menu=0', { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await wait(BOOT);
  out.menuOff = await state(page);
  out.walkedWithMenuOff = await walk(page, HOLD);
}

console.log(JSON.stringify(out, null, 2));
await browser.close();
