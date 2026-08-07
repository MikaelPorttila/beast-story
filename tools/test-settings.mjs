// The settings-storage guard: one localStorage key per setting, a migration
// off the old blob, and a vibration switch the game actually obeys.
//
// Five claims, each driven rather than computed:
//
//   1. A FRESH profile writes nothing. Defaults are defaults because the keys
//      are absent, not because something stamped them at boot — otherwise
//      "never chosen" and "chose the default" stop being distinguishable, which
//      is exactly the distinction `lang: null` depends on.
//   2. A pre-existing `bs:prefs` blob MIGRATES: every field lands under its
//      `game.settings.<group>.<name>` key, the blob is gone afterwards, and the
//      language it carried is on screen — the menu comes up in Swedish.
//   3. Toggling "Enable Controller Vibration" writes `false` to
//      `game.settings.controls.hapticFeedback` and ONLY that key, the running
//      feedback system reports the switch off (`__dbgFeedback`), and a reload
//      in the same profile comes back off.
//   4. The other rows still write their own keys — the invert toggles are what
//      the per-key write has to not clobber.
//   5. The GRAPHICS tab writes the F3 panel's keys, removes one again when the
//      row goes back to its default, and reaches the game that New Game starts
//      — which is the interesting half, because it is flipped before the
//      renderer it drives exists. See the block at the bottom.
//
//   bun tools/test-settings.mjs
import { launchBrowser, newContextPage, wait, logPageErrors } from './browser.mjs';
import { BASE as HOST, NO_WARMUP } from './target.mjs';

const BOOT = 2500;

/** Every settings key in the profile, plus the legacy blob. */
const stored = (page) => page.evaluate(() => {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k.startsWith('game.settings.') || k === 'bs:prefs') out[k] = localStorage.getItem(k);
  }
  return out;
});

const feedback = (page) => page.evaluate(() => window.__dbgFeedback?.() ?? null);

/**
 * Walk the menu to one section of the settings list: any key leaves the splash,
 * then in, then to the tab asked for.
 *
 * The tab step is not decoration. The list is four sections now (ui/settings.ts)
 * and only the one showing is in the DOM, so a click on a row of any other one
 * is a click on nothing — which is what every assertion below would have become.
 */
async function openSettings(page, tab = 'gameplay') {
  await page.keyboard.press('KeyK');
  await wait(400);
  await page.click('.bs-menu [data-act="settings"]');
  await wait(300);
  await page.click(`.bs-menu [data-tab="${tab}"]`);
  await wait(300);
}

const rowState = (page, key) => page.evaluate((k) => {
  const b = document.querySelector(`.bs-menu [data-toggle="${k}"]`);
  return b && {
    label: b.querySelector('.lbl')?.textContent?.trim() ?? null,
    pill: b.querySelector('.pill')?.textContent?.trim() ?? null,
    pressed: b.getAttribute('aria-pressed'),
  };
}, key);

const browser = await launchBrowser();
const out = {};

// ---- a fresh profile stores nothing, and vibration is on -------------------
{
  const { ctx, page } = await newContextPage(browser, { width: 1000, height: 700 });
  logPageErrors(page);
// NO_WARMUP on all five loads: this file reads rows, keys and the prefs a
// setting wrote, and its one frame-shaped assertion (the drained feedback cue)
// is a count, not a cost — see the note in tools/target.mjs.
  await page.goto(`${HOST}/?fps=30&menu=0&${NO_WARMUP}`, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await wait(BOOT);
  out.freshKeys = await stored(page);
  out.freshFeedback = await feedback(page);
  await ctx.close();
}

// ---- the old blob migrates, language and all -------------------------------
{
  const { ctx, page } = await newContextPage(browser, { width: 1000, height: 700 });
  logPageErrors(page);
  // Written before any of the game's own script runs, which is the only way to
  // stage the state a returning player actually has.
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('bs:prefs', JSON.stringify({
      hapticIntensity: 0.5,
      shakeIntensity: 0.25,
      volume: 0.4,
      invertLookX: true,
      invertLookY: false,
      lang: 'sv',
    }));
  });
  await page.goto(`${HOST}/?fps=30&${NO_WARMUP}`, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await wait(BOOT);
  out.migrated = await stored(page);
  out.migratedFeedback = await feedback(page);
  // End to end: a migrated `lang` is a menu in Swedish. 'Nytt spel' is
  // `menu.newGame` in sv.ts.
  await page.keyboard.press('KeyK');
  await wait(400);
  out.migratedMenu = await page.evaluate(() =>
    [...document.querySelectorAll('.bs-menu .panel button')].map((b) => b.textContent.trim()));
  await ctx.close();
}

// ---- the vibration switch: written, obeyed, and still off after a reload ----
{
  const { ctx, page } = await newContextPage(browser, { width: 1000, height: 700 });
  logPageErrors(page);
  await page.goto(`${HOST}/?fps=30&${NO_WARMUP}`, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await wait(BOOT);
  await openSettings(page, 'controls');
  out.vibrationRow = await rowState(page, 'hapticFeedback');
  out.beforeToggle = await feedback(page);

  await page.click('.bs-menu [data-toggle="hapticFeedback"]');
  await wait(200);
  out.afterToggleRow = await rowState(page, 'hapticFeedback');
  out.afterToggleKeys = await stored(page);
  // The switch is applied LIVE — the point of it is that a pad stops moving now.
  out.afterToggleFeedback = await feedback(page);

  // An invert toggle in the same session must land in its own key without
  // disturbing the one above: that is what the per-key write buys.
  await page.click('.bs-menu [data-toggle="invertLookY"]');
  await wait(200);
  out.afterInvertKeys = await stored(page);

  // Same profile, fresh load: the choice has to survive.
  await page.goto(`${HOST}/?fps=30&menu=0&${NO_WARMUP}`, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await wait(BOOT);
  out.afterReloadKeys = await stored(page);
  out.afterReloadFeedback = await feedback(page);
  await ctx.close();
}

// ---- the Graphics tab writes the F3 panel's own keys ----------------------
// The rows there are not a second copy of the performance panel's switches —
// they are the same model (src/core/gfx.ts) and the same
// `game.settings.graphics.*` keys, which is what makes a row flipped in one of
// them true in the other. Three claims, and the third is the one that needed
// code rather than markup.
//
//   - Turning one off writes `false` under its own key and touches nothing else.
//   - Turning it back on REMOVES the key. The default is the absence of one,
//     the same rule the language follows, and the settings panel writes through
//     `storeGfx` rather than spelling that out a second time — two writers with
//     two opinions about it is two different profiles.
//   - A row flipped AT THE TITLE SCREEN reaches the game that New Game starts.
//     That is the boot order: this panel is usable while the engine and world
//     the graphics sinks drive are still being built, so there is nothing to
//     apply to at the moment of the click, and the value has to be picked up by
//     the `Gfx` constructed afterwards. Asserted through `__dbgGfx`, i.e. what
//     the running game believes, not what storage says.
{
  const { ctx, page } = await newContextPage(browser, { width: 1000, height: 700 });
  logPageErrors(page);
  await page.goto(`${HOST}/?fps=30&fs=0&${NO_WARMUP}`, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await wait(BOOT);
  await openSettings(page, 'graphics');
  out.gfxRows = await page.evaluate(() =>
    [...document.querySelectorAll('.bs-menu [data-gfx]')].map((b) => ({
      id: b.getAttribute('data-gfx'),
      label: b.querySelector('.lbl')?.textContent?.trim() ?? null,
      pressed: b.getAttribute('aria-pressed'),
    })));

  await page.click('.bs-menu [data-gfx="ao"]');
  await wait(200);
  out.gfxAfterOff = await stored(page);
  await page.click('.bs-menu [data-gfx="ao"]');
  await wait(200);
  out.gfxAfterOn = await stored(page);

  // Off again, and then into a game with it.
  await page.click('.bs-menu [data-gfx="ao"]');
  await wait(200);
  await page.click('.bs-menu [data-act="back"]');
  await wait(300);
  await page.click('.bs-menu [data-act="new"]');
  await page.waitForFunction(() => window.__dbgBoot?.().playing === true, { timeout: 60000 });
  await wait(2500);
  out.gfxInGame = await page.evaluate(() => window.__dbgGfx?.() ?? null);
  await ctx.close();
}

console.log(JSON.stringify(out, null, 2));
await browser.close();
