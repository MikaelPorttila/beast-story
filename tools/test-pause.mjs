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
import { BASE as HOST } from './target.mjs';

const SETTLE = 5000;
/** How long W is held per walk. At ~6 m/s that is a distance nothing rounds to 0. */
const HOLD_MS = 1200;

const browser = await launchBrowser();
const round = (v, n = 2) => +v.toFixed(n);

const open = async (query) => {
  const p = await newPage(browser, { width: 1100, height: 700 });
  logPageErrors(p);
  await p.goto(`${HOST}/?${query}`, { waitUntil: 'load' });
  await p.waitForSelector('canvas');
  await wait(SETTLE);
  return p;
};

const has = (page, sel) => page.evaluate((s) => !!document.querySelector(s), sel);
const pos = (page) => page.evaluate(() => window.__dbgPlayerPos());

/** Hold W and report how far the hero actually got. */
/**
 * Hold W and report how far the hero got — AFTER pointing the camera somewhere
 * he can actually go.
 *
 * The aim is not optional and the reason is the opening pose. A new session
 * starts the hero beside the camp fire with the camera on his FACE
 * (World.playerStart), so `cam.forward` runs from the lens THROUGH him and into
 * the huts behind: measured, a held W travels 2.73 units and stops against a
 * wall, where the same hold along his own facing travels 8.66. Every `travel >
 * 4` in this file is a proxy for "the hero is being simulated at all", and a
 * proxy that reads the geometry behind the spawn instead is measuring the camp.
 * main.ts's own note on `__dbgAim` says it: a test that cannot turn the camera
 * can only ever drive the hero in one direction.
 *
 * HIS OWN FACING is the bearing, not a pinned one — it is where the greeter is
 * looking, which is the gate, which is where the road goes. Derived, so a seed
 * that moved the camp moves this with it.
 *
 * RE-AIMED ON EVERY CALL rather than once after boot, because `Player.reset()`
 * goes through `takeStartPose()` — so Exit to title and a second New Game put
 * the camera back on his face, and arm 2 of this file does exactly that.
 */
async function walk(page) {
  const yaw = await page.evaluate(() => window.__dbgStart?.().start.yaw ?? 0);
  await page.evaluate((b) => window.__dbgAim(b), yaw);
  // The swing is written outright but `cam.forward` follows the SMOOTHED camera
  // position, so a hold pressed immediately walks off along the old heading.
  await wait(700);
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
    tabs: [...document.querySelectorAll('.bs-pause [data-tab]')].map((b) => b.getAttribute('data-tab')),
    // The tab it opens on, which is also the one holding the language row.
    openTab: document.querySelector('.bs-pause [data-tab].on')?.getAttribute('data-tab') ?? null,
    toggles: [...document.querySelectorAll('.bs-pause .sec:not(.off) [data-toggle]')]
      .map((b) => b.getAttribute('data-toggle')),
    langChips: document.querySelectorAll('.bs-pause [data-lang]').length,
    langAllDisabled: [...document.querySelectorAll('.bs-pause [data-lang]')].every((b) => b.disabled),
    langRowGreyed: !!document.querySelector('.bs-pause .row.lang.off'),
  }));

  // EACH TAB SHOWS ITS OWN ROWS AND ONLY ITS OWN — and "shows" is the word, not
  // "holds". Every section is in the DOM at once, stacked in one grid cell, which
  // is what makes the panel's height constant (ui/settings.ts); what a tab
  // changes is which one is VISIBLE and which buttons are focus stops. So the
  // reading is by visibility and by the host's own cursor list, never by
  // querySelectorAll, which would now answer the same thing on every tab.
  //
  // `panelH` is the point of the whole arrangement: it must not move between
  // tabs. It used to swing 111px -> 327px, and the Back button a player was
  // aiming at moved with it.
  const tabRows = async (tab) => {
    await page.evaluate((t) => document.querySelector(`.bs-pause [data-tab="${t}"]`)?.click(), tab);
    await wait(300);
    return page.evaluate(() => {
      const shown = (attr) => [...document.querySelectorAll(`.bs-pause .sec:not(.off) [${attr}]`)]
        .map((b) => b.getAttribute(attr));
      const rows = document.querySelector('.bs-pause .rows');
      return {
        lit: document.querySelector('.bs-pause [data-tab].on')?.getAttribute('data-tab') ?? null,
        toggles: shown('data-toggle'),
        gfx: shown('data-gfx'),
        vols: shown('data-vol').length,
        langs: shown('data-lang').length,
        // Nothing from the sections that are NOT showing may be reachable: the
        // browser cannot focus them (visibility:hidden) and FOCUSABLE keeps a pad
        // cursor out. This is the count a host's own selector would return.
        strayFocusable: document.querySelectorAll(
          '.bs-pause .sec.off button:not([disabled]):not([tabindex="-1"]):not(.sec.off *)').length,
        panelH: rows ? +rows.getBoundingClientRect().height.toFixed(1) : 0,
        // A pad has no mouse: the cursor has to land back on the tab just pressed,
        // not at the top of a list that was rebuilt under it.
        focus: document.activeElement?.getAttribute('data-tab') ?? null,
      };
    });
  };
  menu.tabControls = await tabRows('controls');
  menu.tabGraphics = await tabRows('graphics');
  menu.tabSound = await tabRows('sound');
  menu.tabGameplay = await tabRows('gameplay');

  // THE TAB STRIP IS ONE CONTROL. Two claims, and the first is the one the
  // feedback on the PR was about: a pad player must reach the rows in ONE step
  // down, not five, so the four tabs are a single stop in the host's cursor list.
  // The second is what left/right then means — the SECTION changes, rather than
  // the cursor walking to the next button and waiting to be pressed.
  menu.tabsAsOneControl = await page.evaluate(() => {
    const stops = [...document.querySelectorAll(
      '.bs-pause .pane button:not([disabled]):not([tabindex="-1"]):not(.sec.off *)')];
    return {
      tabStops: stops.filter((b) => b.hasAttribute('data-tab')).length,
      // Everything before the first row: the strip, and nothing else.
      firstStop: stops[0]?.getAttribute('data-tab') ?? null,
      total: stops.length,
    };
  });
  // Left and right off the tab strip, by KEY — the same edge a pad's d-pad taps.
  await page.evaluate(() => document.querySelector('.bs-pause [data-tab="gameplay"]')?.focus());
  const litTab = () => page.evaluate(() =>
    document.querySelector('.bs-pause [data-tab].on')?.getAttribute('data-tab') ?? null);
  await page.keyboard.press('ArrowRight');
  await wait(250);
  const afterRight = await litTab();
  await page.keyboard.press('ArrowLeft');
  await wait(250);
  await page.keyboard.press('ArrowLeft');
  await wait(250);
  menu.tabArrows = { afterRight, afterWrapBack: await litTab() };

  // THE VOLUME LEVELS ARE ONE CONTROL TOO, and MUTE is deliberately not in it:
  // OFF is the feature switched off rather than a quieter level, so it keeps a
  // stop of its own and a player sweeping the scale cannot land on it by
  // accident. Left/right moves the level and CLAMPS at the ends — one nudge past
  // 100 landing on 20 is a thing nobody wants and everybody would do.
  await page.evaluate(() => document.querySelector('.bs-pause [data-tab="sound"]')?.click());
  await wait(300);
  const vol = () => page.evaluate(() => ({
    lit: document.querySelector('.bs-pause [data-vol].on')?.getAttribute('data-vol') ?? null,
    focus: document.activeElement?.getAttribute('data-vol') ?? null,
    stored: localStorage.getItem('game.settings.gameplay.volume'),
  }));
  menu.volStops = await page.evaluate(() => {
    const stops = [...document.querySelectorAll(
      '.bs-pause .sec:not(.off) button:not([disabled]):not([tabindex="-1"])')];
    return stops.map((b) => b.getAttribute('data-vol'));
  });
  await page.evaluate(() => document.querySelector('.bs-pause [data-vol="80"]')?.focus());
  await page.keyboard.press('ArrowRight');
  await wait(250);
  menu.volAfterRight = await vol();
  await page.keyboard.press('ArrowRight');
  await wait(250);
  menu.volAtCeiling = await vol();
  await page.evaluate(() => document.querySelector('.bs-pause [data-vol="80"]')?.click());
  await wait(250);
  await page.evaluate(() => document.querySelector('.bs-pause [data-tab="gameplay"]')?.click());
  await wait(250);

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
// Arm 1b: THE ESCAPE THE BROWSER ATE
//
// A page holding pointer lock is never given the Escape that releases it — the
// browser spends the key on the lock — so in any browser without the keyboard
// lock (Brave nulls `navigator.keyboard` outright; see ui/fullscreen.ts) the
// menu key did nothing on the press that mattered and worked on the next one,
// by which time the lock was already gone. That is "Escape only opens the menu
// every other time", reported by a player, and it is one missing edge.
//
// `document.exitPointerLock()` from the page is exactly what the browser does
// to that lock, and it is how this is driven — the real key cannot be used,
// because a synthetic Escape over CDP does NOT make the browser release
// anything, so the very state under test would never be entered.
//
// THE SECOND HALF IS THE ONE THAT CAN GO WRONG. Every deliberate release —
// Alt freeing the cursor, a shop opening — goes through `releaseLock`, which
// clears the intent first, and must NOT raise the menu. A rule written as "the
// lock went away" instead of "the lock was TAKEN" passes the first assertion
// here and pops a menu in the player's face every time they hold Alt.
// ---------------------------------------------------------------------------
const lockLost = {};
{
  const page = await open('fps=30&menu=0&fs=0');
  // The lock is normally taken by the first click in the world; take it the same
  // way, and skip the section rather than assert on a browser that refused.
  await page.mouse.click(550, 350);
  await wait(400);
  lockLost.locked = await page.evaluate(() => document.pointerLockElement !== null);

  await page.evaluate(() => document.exitPointerLock());
  await wait(500);
  lockLost.menuAfterTaken = await has(page, '.bs-pause');
  // ONE edge, not a toggle: still up a moment later.
  await wait(700);
  lockLost.stillUp = await has(page, '.bs-pause');

  await page.keyboard.press('Escape');
  await wait(500);
  lockLost.closedByEscape = !(await has(page, '.bs-pause'));
  // AND THE POINTER IS NOT TAKEN BACK, which is the other half of the same bug.
  // Closing with Escape used to re-take it twice over (the menu's own `onClose`
  // and `updateCursorMode`'s menu branch), and the fullscreen exit that the same
  // key was still causing released it again 8 ms later — a loss that reads as a
  // fresh Escape, so the menu reopened on its own. In a browser holding the
  // keyboard lock the browser is spending nothing and the lock IS re-taken; this
  // run has no such API, which is exactly the case that broke.
  lockLost.lockAfterKeyClose = await page.evaluate(() => document.pointerLockElement !== null);
  await wait(700);
  lockLost.stillClosed = !(await has(page, '.bs-pause'));
  // A click is how it comes back, as it always has.
  await page.mouse.click(550, 350);
  await wait(400);
  lockLost.relockedByClick = await page.evaluate(() => document.pointerLockElement !== null);

  // Alt is a HOLD that frees the cursor deliberately. No menu.
  await page.keyboard.down('Alt');
  await wait(500);
  lockLost.menuWhileAltHeld = await has(page, '.bs-pause');
  await page.keyboard.up('Alt');
  await wait(400);
  lockLost.relockedAfterAlt = await page.evaluate(() => document.pointerLockElement !== null);
  await page.close();
}

// ---------------------------------------------------------------------------
// Arm 1c: A WINDOW THAT LOST FOCUS ASKED FOR NOTHING — issue #79
//
// The browser drops pointer lock on an alt-tab, on a click into another window
// and on a notification stealing focus, and every one of those arrived at
// `onLockLost` looking exactly like the Escape of arm 1b: the game paused itself
// behind the player's back, and they came back to a menu they never opened and
// a hero who had stopped moving. Both halves of the report are measured here —
// no menu, and the world still runs.
//
// DRIVEN AS THE TWO EVENTS THE BROWSER SENDS, in both orders, because the order
// is the hazard. Nothing in either spec fixes whether `blur` or
// `pointerlockchange` lands first, so `Input` reads two things and the two arms
// below defeat one each:
//
//   blur first  — dispatch the real `blur` event, then drop the lock. Only the
//                 latch says anything; `document.hasFocus()` is still true.
//   lock first  — stub `hasFocus()` to false with the latch left standing. Only
//                 the live read says anything.
//
// Neither can be driven by taking focus away for real: a background page still
// answers `evaluate`, but CDP has no reliable "this window is not the active
// one" for a headless run, and a probe that silently degrades to "focus never
// went anywhere" is a probe that passes against the bug.
//
// THE CONTROL IS AT THE END and is not optional: a lock taken with focus held
// must still raise the menu, or this whole arm passes against a build with the
// hook simply deleted — which is arm 1b's feature.
// ---------------------------------------------------------------------------
const unfocused = {};
if (lockLost.locked) {
  const page = await open('fps=30&menu=0&fs=0');
  const relock = async () => {
    await page.mouse.click(550, 350);
    await wait(400);
    return page.evaluate(() => document.pointerLockElement !== null);
  };
  unfocused.locked = await relock();

  // 1. blur, then the lock — the alt-tab, in the order a browser sends it.
  await page.evaluate(() => {
    window.dispatchEvent(new FocusEvent('blur'));
    document.exitPointerLock();
  });
  await wait(600);
  unfocused.menuAfterBlur = await has(page, '.bs-pause');
  // AND NOTHING PAUSED. `walk` re-aims and holds W, so this is the same
  // measurement `travelWithMenuUp` makes and the opposite expectation.
  unfocused.travelAfterBlur = await walk(page);

  // 2. the lock, then the blur — the same loss with the events transposed.
  await page.evaluate(() => window.dispatchEvent(new FocusEvent('focus')));
  unfocused.relocked = await relock();
  await page.evaluate(() => {
    // An own property shadowing Document.prototype.hasFocus, so the `delete`
    // below puts the real one back rather than leaving a liar on the page.
    document.hasFocus = () => false;
    document.exitPointerLock();
  });
  await wait(600);
  unfocused.menuAfterLockFirst = await has(page, '.bs-pause');
  await page.evaluate(() => { delete document.hasFocus; });

  // 3. THE CONTROL: focus never went anywhere, so this one is Escape.
  unfocused.relockedForControl = await relock();
  await page.evaluate(() => document.exitPointerLock());
  await wait(600);
  unfocused.menuWithFocusHeld = await has(page, '.bs-pause');
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
  await page.goto(`${HOST}/?fps=30&menu=0&fs=0`, { waitUntil: 'load' });
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
  // WHERE A SESSION BEGINS, which is no longer `__dbgTowns().spawn`: that is the
  // world's reference point out on the road, and the hero now starts beside the
  // camp fire (World.playerStart). The question this section asks is "did New
  // Game put a FRESH hero on screen, or hand back the one who wandered off",
  // and only the start pose can answer it.
  const spawn = await page.evaluate(() => window.__dbgStart().start);
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

  // THE POINTER HAS TO BE BACK, and this is the one assertion here that a
  // synthetic click cannot make for you. `close()` hands the pointer to the
  // game (right on Continue) and `exitToTitle` then releases it, one call
  // later — but `requestPointerLock()` resolves asynchronously, so the release
  // used to look at an empty `document.pointerLockElement` and do nothing,
  // and the lock landed a moment afterwards ON THE TITLE SCREEN. Issue #29:
  // no cursor, and every click on New Game delivered to the canvas underneath
  // the poster, which therefore sat there with its fairies and lit lanterns.
  exit.lockAtTitle = await page.evaluate(() =>
    document.pointerLockElement?.tagName ?? null);

  // Round again, and with a REAL MOUSE CLICK rather than `el.click()`. That
  // distinction is the whole point: a synthetic click is dispatched straight at
  // the button and passes however the pointer is behaving, so the run above
  // stayed green through the entire life of the bug. This one goes through the
  // browser's hit testing, which is what a player has.
  {
    const btn = await page.waitForSelector('.bs-menu [data-act="new"]', { visible: true });
    await btn.click();
  }
  await wait(SETTLE);
  // Nothing of the poster may outlive the handover — not the element, and not
  // the fairies and lantern glows animating inside it.
  exit.posterRemnants = await page.evaluate(() => ({
    menus: document.querySelectorAll('.bs-menu').length,
    flies: document.querySelectorAll('.fly').length,
    lamps: document.querySelectorAll('.lamp').length,
  }));
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
check(JSON.stringify(menu.settings.tabs)
  === JSON.stringify(['gameplay', 'controls', 'graphics', 'sound']),
  'the settings list is the shared one, in four sections');
check(menu.settings.openTab === 'gameplay', 'and opens on Gameplay');
check(menu.settings.langChips > 0 && menu.settings.langAllDisabled,
  'the language picker is disabled in game');
check(menu.settings.langRowGreyed, 'and says so');
// ONE SECTION AT A TIME, which is the point of the split — see ui/settings.ts.
check(JSON.stringify(menu.tabControls.toggles)
  === JSON.stringify(['hapticFeedback', 'invertLookX', 'invertLookY']),
  'Controls holds the three controller rows');
check(JSON.stringify(menu.tabGraphics.gfx)
  === JSON.stringify(['ao', 'bloom', 'aa', 'shadows', 'grass']),
  'Graphics holds the five renderer switches');
check(menu.tabGraphics.toggles.length === 0 && menu.tabGraphics.langs === 0,
  'and nothing from the other tabs is still on screen with them');
check(menu.tabSound.vols === 6, 'Sound holds the volume steps');
check(menu.tabGameplay.toggles.length === 1 && menu.tabGameplay.langs > 0,
  'Gameplay holds fullscreen-on-start and the language picker');
for (const [name, t] of Object.entries({
  controls: menu.tabControls, graphics: menu.tabGraphics,
  sound: menu.tabSound, gameplay: menu.tabGameplay,
})) {
  check(t.lit === name, `the ${name} tab lights when it is pressed (lit ${t.lit})`);
  check(t.focus === name, `and keeps the cursor on itself through the rebuild (${t.focus})`);
  check(t.strayFocusable === 0,
    `${t.strayFocusable} buttons in a hidden section are still focus stops on ${name}`);
}
// THE PANEL DOES NOT RESIZE WHEN YOU CHANGE TABS. The sections are stacked, so
// the box is as tall as the tallest of them whichever one is showing — which is
// what stops the Back button walking away from a cursor that is aiming at it.
{
  const hs = [menu.tabGameplay, menu.tabControls, menu.tabGraphics, menu.tabSound]
    .map((t) => t.panelH);
  check(hs[0] > 0 && new Set(hs).size === 1,
    `the settings box changes height between tabs: ${hs.join(' / ')}px`);
}
// ONE CONTROL, not four buttons — the PR feedback, and the reason a pad reaches
// the rows in one step down.
check(menu.tabsAsOneControl.tabStops === 1,
  `the tab strip is ${menu.tabsAsOneControl.tabStops} stops in the cursor list, expected 1`);
check(menu.tabsAsOneControl.firstStop === 'gameplay',
  'and it is the first thing the cursor lands on');
check(menu.tabArrows.afterRight === 'controls',
  `right on the tab strip changed the section to ${menu.tabArrows.afterRight}, expected controls`);
// Two lefts from Controls: Gameplay, then round the end onto Sound. A ring,
// because there is no first or last section.
check(menu.tabArrows.afterWrapBack === 'sound',
  `left off the first tab did not wrap to the last (${menu.tabArrows.afterWrapBack})`);
// The volume levels are one control and MUTE is beside it, not in it.
check(JSON.stringify(menu.volStops) === JSON.stringify(['0', '80']),
  `the music row's stops are ${JSON.stringify(menu.volStops)}, expected OFF and the lit level`);
check(menu.volAfterRight.lit === '100' && menu.volAfterRight.stored === '1',
  `right on the volume strip gave ${menu.volAfterRight.lit} / ${menu.volAfterRight.stored}`);
check(menu.volAfterRight.focus === '100',
  'and the cursor followed the value rather than being dropped');
check(menu.volAtCeiling.lit === '100',
  `the volume strip wrapped past its top instead of clamping (${menu.volAtCeiling.lit})`);
check(menu.escapeFromSettings.stillOpen && menu.escapeFromSettings.backOnTheList,
  'Escape backs out of Settings rather than closing');
check(menu.escapeFromSettings.focus === 'settings', 'and leaves the cursor where it went in');

// The lock the browser TAKES is the Escape it ate. Skipped, loudly, if this
// browser refused the lock in the first place — asserting on it then would be
// asserting on the harness.
if (lockLost.locked) {
  check(lockLost.menuAfterTaken, 'a pointer lock taken away raises the menu');
  check(lockLost.stillUp, 'and it is ONE edge — the menu is still up a moment later');
  check(lockLost.closedByEscape, 'Escape then closes it as usual');
  check(lockLost.lockAfterKeyClose === false,
    'and does NOT hand the browser a fresh lock to knock out mid-Escape');
  check(lockLost.stillClosed, 'so the menu stays closed instead of reopening itself');
  check(lockLost.relockedByClick, 'a click takes the pointer back');
  check(lockLost.menuWhileAltHeld === false,
    'holding Alt frees the cursor WITHOUT raising the menu');
  check(lockLost.relockedAfterAlt, 'and releasing Alt takes the pointer back');

  // Issue #79. Skipped along with 1b, and for the same reason.
  check(unfocused.locked && unfocused.relocked && unfocused.relockedForControl,
    'arm 1c could not take the pointer for one of its three rounds');
  check(unfocused.menuAfterBlur === false,
    'losing window focus raised the in-game menu — an alt-tab is not an Escape');
  check(unfocused.travelAfterBlur > 4,
    `the hero travelled ${unfocused.travelAfterBlur} after a focus loss — losing `
    + 'focus must not pause the game');
  check(unfocused.menuAfterLockFirst === false,
    'a lock dropped before the blur event landed raised the menu — the live '
    + 'hasFocus() read is what covers that order');
  check(unfocused.menuWithFocusHeld,
    'a pointer lock taken with focus HELD did not raise the menu — the two '
    + 'assertions above are passing because the hook is dead, not because it is fixed');
} else {
  console.error('note: this browser never granted pointer lock — arms 1b/1c skipped');
}

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
check(exit.lockAtTitle === null,
  `the pointer is given back at the title screen (locked to ${exit.lockAtTitle})`);
check(exit.secondGame.menuGone, 'New Game works a second time, from a real mouse click');
check(exit.secondGame.fromSpawn < 3, 'and the second hero starts at the opening pose');
check(exit.secondGame.travel > 4, 'and can walk');
// Belt and braces on the same handover: the element going is what `menuGone`
// says, and these are the two things INSIDE it that the player actually sees.
check(exit.posterRemnants.menus === 0, 'no poster survives the second handover');
check(exit.posterRemnants.flies === 0 && exit.posterRemnants.lamps === 0,
  `no fairies or lantern glows left over (${exit.posterRemnants.flies} flies, ` +
  `${exit.posterRemnants.lamps} lamps)`);

console.log(JSON.stringify(
  { menu, lockLost, unfocused, gamepad, exit, failures: fail, pass: fail.length === 0 }, null, 2));
if (fail.length) process.exitCode = 1;
