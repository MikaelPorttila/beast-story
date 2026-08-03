// The settings-storage guard: one localStorage key per setting, a migration
// off the old blob, and a vibration switch the game actually obeys.
//
// Four claims, each driven rather than computed:
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
//
//   bun tools/test-settings.mjs
import { launchBrowser, newContextPage, wait, logPageErrors } from './browser.mjs';
import { BASE as HOST } from './target.mjs';

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

/** Walk the menu to the settings list: any key leaves the splash, then in. */
async function openSettings(page) {
  await page.keyboard.press('KeyK');
  await wait(400);
  await page.click('.bs-menu [data-act="settings"]');
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
  await page.goto(`${HOST}/?fps=30&menu=0`, { waitUntil: 'load' });
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
  await page.goto(`${HOST}/?fps=30`, { waitUntil: 'load' });
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
  await page.goto(`${HOST}/?fps=30`, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await wait(BOOT);
  await openSettings(page);
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
  await page.goto(`${HOST}/?fps=30&menu=0`, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await wait(BOOT);
  out.afterReloadKeys = await stored(page);
  out.afterReloadFeedback = await feedback(page);
  await ctx.close();
}

console.log(JSON.stringify(out, null, 2));
await browser.close();
