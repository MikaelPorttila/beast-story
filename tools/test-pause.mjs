// The in-game menu: Escape / Start / the touch overlay's MENU, and what the
// three options behind it do.
//
// Usage: bun tools/test-pause.mjs
//
// TWO ARMS, and the split is the interesting part of this file.
//
// The first runs under `menu=0` like every other probe in tools/, because
// everything about the menu ITSELF — that Escape raises it, that it freezes the
// hero, that its Settings step is the same list the title screen shows, that
// Escape backs out of that step rather than closing — is answerable with a hero
// standing in a world and no title screen anywhere.
//
// The second CANNOT be. `Exit to title` raises a `StartMenu`, and `StartMenu.offer`
// refuses to build one under `menu=0` — which is not a wrinkle to work around,
// it is the flag doing exactly its job. So the exit arm walks the STAGED boot
// instead: press-any-key, New Game, play, Escape, Exit, and then round again to
// prove the second game is a game and not a husk. tools/test-keybinds.mjs drops
// `menu=0` for the same reason and is the precedent.
//
// `fs=0` throughout: New Game takes fullscreen otherwise and resizes the
// viewport under everything being measured.
import {
  launchBrowser, newPage, wait, logPageErrors,
  installFakePad, setPadButton, PAD_BUTTON,
} from './browser.mjs';

const SETTLE = 5000;
/** How long W is held per walk. At ~6 m/s that is a distance nothing rounds to 0. */
const HOLD_MS = 1200;

const browser = await launchBrowser();
const round = (v, n = 2) => +v.toFixed(n);

const open = async (query) => {
  const p = await newPage(browser, { width: 1100, height: 700 });
  logPageErrors(p);
  await p.goto(`http://localhost:5187/?${query}`, { waitUntil: 'load' });
  await p.waitForSelector('canvas');
  await wait(SETTLE);
  return p;
};

const has = (page, sel) => page.evaluate((s) => !!document.querySelector(s), sel);
const pos = (page) => page.evaluate(() => window.__dbgPlayerPos());

/** Hold W and report how far the hero actually got. */
async function walk(page) {
  const a = await pos(page);
  await page.keyboard.down('KeyW');
  await wait(HOLD_MS);
  await page.keyboard.up('KeyW');
  await wait(200);
  const b = await pos(page);
  return round(Math.hypot(b.x - a.x, b.z - a.z));
}

// ---------------------------------------------------------------------------
// Arm 1: the menu, with no title screen in the picture
// ---------------------------------------------------------------------------
const menu = {};
{
  const page = await open('fps=30&menu=0&fs=0');
  menu.beforeEscape = await has(page, '.bs-pause');
  await page.keyboard.press('Escape');
  await wait(400);
  menu.afterEscape = await has(page, '.bs-pause');
  menu.rows = await page.evaluate(() =>
    [...document.querySelectorAll('.bs-pause [data-act]')].map((b) => b.getAttribute('data-act')));
  // A pad player has no mouse: something has to be under the cursor on open.
  menu.focusOnOpen = await page.evaluate(() =>
    document.activeElement?.getAttribute('data-act') ?? null);

  // THE MODAL ASSERTION, and the reason the menu is worth a probe at all: a
  // player who stopped to change a setting must not have walked off a cliff.
  menu.travelWithMenuUp = await walk(page);

  // Settings is the SAME view the title screen shows (ui/settings.ts), with the
  // one row that cannot be answered in game disabled and explained.
  await page.evaluate(() => document.querySelector('.bs-pause [data-act="settings"]')?.click());
  await wait(400);
  menu.settings = await page.evaluate(() => ({
    toggles: [...document.querySelectorAll('.bs-pause [data-toggle]')]
      .map((b) => b.getAttribute('data-toggle')),
    langChips: document.querySelectorAll('.bs-pause [data-lang]').length,
    langAllDisabled: [...document.querySelectorAll('.bs-pause [data-lang]')].every((b) => b.disabled),
    langRowGreyed: !!document.querySelector('.bs-pause .row.lang.off'),
  }));

  // Escape means "up one", not "close": that is what makes one key both the way
  // in and the whole way out.
  await page.keyboard.press('Escape');
  await wait(400);
  menu.escapeFromSettings = {
    stillOpen: await has(page, '.bs-pause'),
    backOnTheList: await has(page, '.bs-pause [data-act="exit"]'),
    // Coming out of a submenu leaves the cursor where you went in.
    focus: await page.evaluate(() => document.activeElement?.getAttribute('data-act') ?? null),
  };

  await page.evaluate(() => document.querySelector('.bs-pause [data-act="continue"]')?.click());
  await wait(400);
  menu.closedByContinue = !(await has(page, '.bs-pause'));
  menu.travelAfterContinue = await walk(page);
  await page.close();
}

// ---------------------------------------------------------------------------
// Arm 2: START, ON A PAD, COUNTED ONCE
//
// The assertion this file exists for most, because it is the failure a player
// reported and the one no other probe could see. Start opens this menu AND
// closes it, so an edge counted twice is a button that "sometimes does nothing":
// the first read opens, the second — one poll later, off the same unreleased
// press — closes it again. Nothing is on screen and nothing looks broken.
//
// It is measured by HOLDING the button rather than tapping it. A tap can be over
// before the second poll and would pass against the bug; the bug is specifically
// about a button that is still down when the modal opens, which is every real
// press. `GamepadControls.setModal(true)` used to zero its edge history at
// exactly that moment — see the note there.
// ---------------------------------------------------------------------------
const gamepad = {};
{
  const page = await newPage(browser, { width: 1100, height: 700 });
  logPageErrors(page);
  await installFakePad(page, 'Xbox 360 Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)');
  await page.goto('http://localhost:5187/?fps=30&menu=0&fs=0', { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await wait(SETTLE);
  await page.evaluate(() => window.__connectPad());
  await wait(300);

  // HELD across many polls, then released.
  await setPadButton(page, PAD_BUTTON.START, true);
  await wait(900);
  gamepad.openWhileHeld = await has(page, '.bs-pause');
  await setPadButton(page, PAD_BUTTON.START, false);
  await wait(400);
  gamepad.openAfterRelease = await has(page, '.bs-pause');

  // And again: the same press has to close it, once.
  await setPadButton(page, PAD_BUTTON.START, true);
  await wait(900);
  await setPadButton(page, PAD_BUTTON.START, false);
  await wait(400);
  gamepad.closedBySecondPress = !(await has(page, '.bs-pause'));

  // Third press reopens — proving the edge history survived a modal round trip
  // rather than the menu simply having got stuck shut.
  await setPadButton(page, PAD_BUTTON.START, true);
  await wait(900);
  await setPadButton(page, PAD_BUTTON.START, false);
  await wait(400);
  gamepad.reopenedByThirdPress = await has(page, '.bs-pause');
  await page.close();
}

// ---------------------------------------------------------------------------
// Arm 3: Exit, which needs a title screen to come back to
// ---------------------------------------------------------------------------
const exit = {};
{
  const page = await open('fps=30&fs=0');
  // Through the staged boot: any key leaves the splash, then New Game.
  await page.keyboard.press('Enter');
  await wait(400);
  await page.evaluate(() => document.querySelector('.bs-menu [data-act="new"]')?.click());
  await wait(SETTLE);
  exit.playingFirst = !(await has(page, '.bs-menu'));
  exit.travelFirstGame = await walk(page);

  // Make the session distinguishable from a fresh one, so "it reset" is a
  // measurement rather than a coincidence: stand somewhere the spawn is not.
  await page.evaluate(() => {
    const p = window.__dbgPlayerPos();
    window.__dbgTp(p.x + 30, p.z + 30);
  });
  await wait(600);
  const away = await pos(page);
  const spawn = await page.evaluate(() => window.__dbgTowns().spawn);
  exit.movedAwayFromSpawn = round(Math.hypot(away.x - spawn.x, away.z - spawn.z));

  await page.keyboard.press('Escape');
  await wait(400);
  await page.evaluate(() => document.querySelector('.bs-pause [data-act="exit"]')?.click());
  await wait(1500);
  exit.titleScreenBack = await has(page, '.bs-menu');
  exit.pauseGone = !(await has(page, '.bs-pause'));
  // Straight to the options, not the splash: a player who chose to leave has
  // already pressed start once.
  exit.step = await page.evaluate(() =>
    document.querySelector('.bs-menu')?.getAttribute('data-step') ?? null);

  // Round again. The second game has to be a GAME — the hero back at the spawn,
  // and walking.
  await page.evaluate(() => document.querySelector('.bs-menu [data-act="new"]')?.click());
  await wait(SETTLE);
  const fresh = await pos(page);
  exit.secondGame = {
    menuGone: !(await has(page, '.bs-menu')),
    fromSpawn: round(Math.hypot(fresh.x - spawn.x, fresh.z - spawn.z)),
    travel: await walk(page),
  };
  await page.close();
}

await browser.close();

// ---------------------------------------------------------------------------
// What has to be true
// ---------------------------------------------------------------------------
const fail = [];
const check = (ok, what) => { if (!ok) fail.push(what); };

check(menu.beforeEscape === false && menu.afterEscape === true, 'Escape opens the menu');
check(JSON.stringify(menu.rows) === JSON.stringify(['continue', 'settings', 'exit']),
  'the three options the issue asks for, in order');
check(menu.focusOnOpen === 'continue', 'something is focused on open, for a pad');
// 0 exactly: the hero is not simulated at all while a modal is up.
check(menu.travelWithMenuUp === 0, 'the hero is frozen while the menu is up');
check(menu.travelAfterContinue > 4, 'Continue gives the game back');
check(menu.closedByContinue, 'Continue closes the menu');
check(menu.settings.toggles.length === 4, 'the settings list is the shared one');
check(menu.settings.langChips > 0 && menu.settings.langAllDisabled,
  'the language picker is disabled in game');
check(menu.settings.langRowGreyed, 'and says so');
check(menu.escapeFromSettings.stillOpen && menu.escapeFromSettings.backOnTheList,
  'Escape backs out of Settings rather than closing');
check(menu.escapeFromSettings.focus === 'settings', 'and leaves the cursor where it went in');

check(gamepad.openWhileHeld, 'Start opens the menu');
// The one that fails on the double edge: the menu has to still be there when the
// button comes up, not have been closed by a second edge off the same press.
check(gamepad.openAfterRelease, 'and one press of Start is ONE edge');
check(gamepad.closedBySecondPress, 'a second press closes it');
check(gamepad.reopenedByThirdPress, 'and a third reopens it');

check(exit.playingFirst && exit.travelFirstGame > 4, 'the staged boot reaches a playable game');
check(exit.movedAwayFromSpawn > 20, 'the first session was somewhere the second is not');
check(exit.titleScreenBack && exit.pauseGone, 'Exit puts the title screen back');
check(exit.step === 'options', 'and lands on the options, not the splash');
check(exit.secondGame.menuGone, 'New Game works a second time');
check(exit.secondGame.fromSpawn < 3, 'and the second hero starts at the spawn');
check(exit.secondGame.travel > 4, 'and can walk');

console.log(JSON.stringify({ menu, gamepad, exit, failures: fail, pass: fail.length === 0 }, null, 2));
if (fail.length) process.exitCode = 1;
