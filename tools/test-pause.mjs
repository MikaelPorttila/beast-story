// The in-game menu: F10 / Start / the touch overlay's MENU, and what the three
// options behind it do.
//
// Usage: bun tools/test-pause.mjs        (dev server must be up)
//        ...or as sections inside `bun tools/suite.mjs` — same code either way.
//
// FAST-FORWARDED, SHARED-SESSION, with honest realtime exceptions. The old file
// booted FIVE pages of its own and declared ~65 s of sleeps; the menu arm now
// runs on the suite's shared page with every hold and settle drained through
// `__dbgAdvance` (see tools/suite/harness.mjs). What stays realtime, and why:
//
//   * `lockLost` / `unfocused` drive the browser's OWN pointer-lock machinery —
//     Chrome's ~1.25 s refusal window after a lock is given up (RELOCK_WAIT_MS)
//     and the async resolution of requestPointerLock are wall-clock facts no
//     simulated second can advance. Both sections sleep for real and say so.
//   * `exitTitle` walks the STAGED boot — press-any-key, New Game, play, F10,
//     Exit, and round again — which `StartMenu.offer` refuses to build under
//     `menu=0`. That is the flag doing its job, so this arm runs on a PRIVATE
//     page booted without it (rule: exiting to title on the shared page would
//     strand every module after it at the menu). tools/test-keybinds.mjs drops
//     `menu=0` for the same reason and is the precedent.
//   * `gamepadStart` needs `installFakePad`'s evaluateOnNewDocument, which only
//     a fresh page can take — private page too, but its holds are simulated:
//     `__dbgAdvance` polls the pad every slice, exactly like the real loop.
//
// `fs=0` throughout: New Game takes fullscreen otherwise and resizes the
// viewport under everything being measured.
//
// Exits non-zero.
import {
  installFakePad, leaveSplash, logPageErrors, newPage, PAD_BUTTON, setPadButton,
} from './browser.mjs';
import { BASE as HOST } from './target.mjs';
import { advance } from './suite/harness.mjs';

/** Sleep for REAL milliseconds. Only the realtime sections below may use it. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** How long W is held per walk, in SIMULATED seconds. At ~6 m/s that is a distance nothing rounds to 0. */
const HOLD_S = 1.2;

const round = (v, n = 2) => +v.toFixed(n);
const has = (page, sel) => page.evaluate((s) => !!document.querySelector(s), sel);
const pos = (page) => page.evaluate(() => window.__dbgPlayerPos());

/** Shared by `lockLost` (writes) and `unfocused` (skips without it). */
let lockGranted = false;

/**
 * A screen point whose click actually reaches the CANVAS.
 *
 * COMPOSITION FIX: the fixed (640, 400) is dead centre, and on the shared
 * suite page dead centre is where a den shop's '.bs-buy' buttons sit — they
 * keep pointer-events:auto even with their wrap closed (ui/styles.ts gives
 * the wrap pointer-events:none but the button auto), so once the inventory
 * module has visited a den, a centre click can land on an invisible button
 * and never reach the pointer lock; arm 1c lost all three relock rounds to
 * exactly that. (The invisible-button hit-through is reported as a game bug
 * in its own right; this keeps the probe measuring the lock, not the shop.)
 * Falls back to centre when everything is covered, so a failure still reads
 * as "could not take the pointer" rather than a throw.
 */
const canvasPoint = async (page) => {
  const p = await page.evaluate(() => {
    const cvs = document.querySelector('canvas');
    for (const [x, y] of [[640, 400], [240, 400], [1040, 400], [640, 140], [320, 640]]) {
      if (document.elementFromPoint(x, y) === cvs) return { x, y };
    }
    return null;
  });
  return p ?? { x: 640, y: 400 };
};

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
 * the camera back on his face, and the exit arm does exactly that.
 *
 * Takes a PAGE, not a ctx, because the exit arm runs it on a private page —
 * every hold and settle is simulated through `advance`.
 */
async function walk(page) {
  const yaw = await page.evaluate(() => window.__dbgStart?.().start.yaw ?? 0);
  await page.evaluate((b) => window.__dbgAim(b), yaw);
  // The swing is written outright but `cam.forward` follows the SMOOTHED camera
  // position, so a hold pressed immediately walks off along the old heading.
  await advance(page, 0.7);
  const a = await pos(page);
  await page.keyboard.down('KeyW');
  await advance(page, HOLD_S);
  await page.keyboard.up('KeyW');
  await advance(page, 0.2);
  const b = await pos(page);
  return round(Math.hypot(b.x - a.x, b.z - a.z));
}

export const name = 'pause';
export const sections = [

  // -------------------------------------------------------------------------
  // Arm 1: the menu, with no title screen in the picture — on the shared page.
  // -------------------------------------------------------------------------
  { id: 'stage', run: async (ctx) => {
    // TO THE START POSE, because every walk in this arm aims along `start.yaw`
    // — the direction that is measured to be open from the camp fire — and the
    // shared page's hero may be anywhere a previous module drove him. Then
    // settle the streamer in simulated time, so a walk measures the hero and
    // not chunks arriving under him.
    const start = await ctx.ev(() => window.__dbgStart().start);
    await ctx.tp(start.x, start.z);
    const settled = await ctx.settleStreaming(30);
    ctx.check(settled, 'the streamer never settled after the teleport to the start pose');
    await ctx.adv(0.5);
    // Defensive against an earlier module's leftovers: a pause menu already up
    // would make every reading below measure the wrong thing (rule: F10 in the
    // modal branch CLOSES whatever is open instead of opening the menu).
    if (await has(ctx.page, '.bs-pause')) {
      await ctx.page.keyboard.press('F10');
      await ctx.adv(0.3);
      await ctx.waitFn(() => !document.querySelector('.bs-pause'), 5000);
    }
  } },

  // -------------------------------------------------------------------------
  { id: 'menuKey', run: async (ctx) => {
    const { page } = ctx;
    const m = {};
    m.beforeMenuKey = await has(page, '.bs-pause');
    // F10. The menu moved off Escape because the browser spends that key on its
    // own business — leaving fullscreen, dropping pointer lock — before the page
    // has any say, so half the presses that mattered never arrived as a key.
    // Escape is asserted here too, from the other side: it must NOT open this.
    // Both keys are SIM-side (simulate()'s modal branch), so `adv` consumes them.
    await page.keyboard.press('Escape');
    await ctx.adv(0.4);
    m.afterEscape = await has(page, '.bs-pause');
    await page.keyboard.press('F10');
    await ctx.adv(0.4);
    m.afterMenuKey = await has(page, '.bs-pause');
    m.rows = await ctx.ev(() =>
      [...document.querySelectorAll('.bs-pause [data-act]')].map((b) => b.getAttribute('data-act')));
    // A pad player has no mouse: something has to be under the cursor on open.
    m.focusOnOpen = await ctx.ev(() =>
      document.activeElement?.getAttribute('data-act') ?? null);

    // THE MODAL ASSERTION, and the reason the menu is worth a probe at all: a
    // player who stopped to change a setting must not have walked off a cliff.
    // The hold is simulated — a modal SKIPS the hero's simulation rather than
    // slowing it, so the advanced seconds are exactly what must move him 0.
    m.travelWithMenuUp = await walk(page);

    ctx.res.menuKey = m;
    ctx.check(m.beforeMenuKey === false && m.afterMenuKey === true, 'F10 opens the menu');
    // The other half, and the reason the key moved: Escape is the browser's — it
    // leaves fullscreen and drops the pointer over the page's head — so it must
    // not be carrying the menu as well.
    ctx.check(m.afterEscape === false, 'Escape still opens the in-game menu');
    ctx.check(JSON.stringify(m.rows) === JSON.stringify(['continue', 'settings', 'exit']),
      'the three options the issue asks for, in order');
    ctx.check(m.focusOnOpen === 'continue', 'something is focused on open, for a pad');
    // 0 exactly: the hero is not simulated at all while a modal is up.
    ctx.check(m.travelWithMenuUp === 0, 'the hero is frozen while the menu is up');
  } },

  // -------------------------------------------------------------------------
  { id: 'settingsTabs', run: async (ctx) => {
    // Settings is the SAME view the title screen shows (ui/settings.ts), with the
    // one row that cannot be answered in game disabled and explained. The menu
    // is still up from `menuKey` — that order is this file's contract.
    const { page } = ctx;
    await ctx.ev(() => document.querySelector('.bs-pause [data-act="settings"]')?.click());
    await ctx.frame();
    const settings = await ctx.ev(() => ({
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
      await ctx.ev((t) => document.querySelector(`.bs-pause [data-tab="${t}"]`)?.click(), tab);
      await ctx.frame();
      return ctx.ev(() => {
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
    const tabControls = await tabRows('controls');
    const tabGraphics = await tabRows('graphics');
    const tabSound = await tabRows('sound');
    const tabGameplay = await tabRows('gameplay');

    // THE TAB STRIP IS ONE CONTROL. Two claims, and the first is the one the
    // feedback on the PR was about: a pad player must reach the rows in ONE step
    // down, not five, so the four tabs are a single stop in the host's cursor list.
    // The second is what left/right then means — the SECTION changes, rather than
    // the cursor walking to the next button and waiting to be pressed.
    const tabsAsOneControl = await ctx.ev(() => {
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
    // Handled by the panel's own DOM keydown (ui/pause.ts), so a presented frame
    // is all the settling there is to do.
    await ctx.ev(() => document.querySelector('.bs-pause [data-tab="gameplay"]')?.focus());
    const litTab = () => ctx.ev(() =>
      document.querySelector('.bs-pause [data-tab].on')?.getAttribute('data-tab') ?? null);
    await page.keyboard.press('ArrowRight');
    await ctx.frame();
    const afterRight = await litTab();
    await page.keyboard.press('ArrowLeft');
    await ctx.frame();
    await page.keyboard.press('ArrowLeft');
    await ctx.frame();
    const tabArrows = { afterRight, afterWrapBack: await litTab() };

    ctx.res.settings = settings;
    ctx.res.tabs = { tabControls, tabGraphics, tabSound, tabGameplay, tabsAsOneControl, tabArrows };
    ctx.check(JSON.stringify(settings.tabs)
      === JSON.stringify(['gameplay', 'controls', 'graphics', 'sound']),
      'the settings list is the shared one, in four sections');
    ctx.check(settings.openTab === 'gameplay', 'and opens on Gameplay');
    ctx.check(settings.langChips > 0 && settings.langAllDisabled,
      'the language picker is disabled in game');
    ctx.check(settings.langRowGreyed, 'and says so');
    // ONE SECTION AT A TIME, which is the point of the split — see ui/settings.ts.
    ctx.check(JSON.stringify(tabControls.toggles)
      === JSON.stringify(['hapticFeedback', 'invertLookX', 'invertLookY']),
      'Controls holds the three controller rows');
    ctx.check(JSON.stringify(tabGraphics.gfx)
      === JSON.stringify(['ao', 'bloom', 'aa', 'shadows', 'grass']),
      'Graphics holds the five renderer switches');
    ctx.check(tabGraphics.toggles.length === 0 && tabGraphics.langs === 0,
      'and nothing from the other tabs is still on screen with them');
    ctx.check(tabSound.vols === 6, 'Sound holds the volume steps');
    ctx.check(tabGameplay.toggles.length === 1 && tabGameplay.langs > 0,
      'Gameplay holds fullscreen-on-start and the language picker');
    for (const [tname, t] of Object.entries({
      controls: tabControls, graphics: tabGraphics, sound: tabSound, gameplay: tabGameplay,
    })) {
      ctx.check(t.lit === tname, `the ${tname} tab lights when it is pressed (lit ${t.lit})`);
      ctx.check(t.focus === tname, `and keeps the cursor on itself through the rebuild (${t.focus})`);
      ctx.check(t.strayFocusable === 0,
        `${t.strayFocusable} buttons in a hidden section are still focus stops on ${tname}`);
    }
    // THE PANEL DOES NOT RESIZE WHEN YOU CHANGE TABS. The sections are stacked, so
    // the box is as tall as the tallest of them whichever one is showing — which is
    // what stops the Back button walking away from a cursor that is aiming at it.
    {
      const hs = [tabGameplay, tabControls, tabGraphics, tabSound].map((t) => t.panelH);
      ctx.check(hs[0] > 0 && new Set(hs).size === 1,
        `the settings box changes height between tabs: ${hs.join(' / ')}px`);
    }
    // ONE CONTROL, not four buttons — the PR feedback, and the reason a pad reaches
    // the rows in one step down.
    ctx.check(tabsAsOneControl.tabStops === 1,
      `the tab strip is ${tabsAsOneControl.tabStops} stops in the cursor list, expected 1`);
    ctx.check(tabsAsOneControl.firstStop === 'gameplay',
      'and it is the first thing the cursor lands on');
    ctx.check(tabArrows.afterRight === 'controls',
      `right on the tab strip changed the section to ${tabArrows.afterRight}, expected controls`);
    // Two lefts from Controls: Gameplay, then round the end onto Sound. A ring,
    // because there is no first or last section.
    ctx.check(tabArrows.afterWrapBack === 'sound',
      `left off the first tab did not wrap to the last (${tabArrows.afterWrapBack})`);
  } },

  // -------------------------------------------------------------------------
  { id: 'volume', run: async (ctx) => {
    // THE VOLUME LEVELS ARE ONE CONTROL TOO, and MUTE is deliberately not in it:
    // OFF is the feature switched off rather than a quieter level, so it keeps a
    // stop of its own and a player sweeping the scale cannot land on it by
    // accident. Left/right moves the level and CLAMPS at the ends — one nudge past
    // 100 landing on 20 is a thing nobody wants and everybody would do.
    //
    // ASSUMES the volume is at its default (80): the stop list below reads the
    // lit level. On the shared page a module that changed the volume before this
    // one would break it — this module restores the default and deletes the key
    // when it is done, and expects the same courtesy.
    const { page } = ctx;
    await ctx.ev(() => document.querySelector('.bs-pause [data-tab="sound"]')?.click());
    await ctx.frame();
    const vol = () => ctx.ev(() => ({
      lit: document.querySelector('.bs-pause [data-vol].on')?.getAttribute('data-vol') ?? null,
      focus: document.activeElement?.getAttribute('data-vol') ?? null,
      stored: localStorage.getItem('game.settings.gameplay.volume'),
    }));
    const volStops = await ctx.ev(() => {
      const stops = [...document.querySelectorAll(
        '.bs-pause .sec:not(.off) button:not([disabled]):not([tabindex="-1"])')];
      return stops.map((b) => b.getAttribute('data-vol'));
    });
    await ctx.ev(() => document.querySelector('.bs-pause [data-vol="80"]')?.focus());
    await page.keyboard.press('ArrowRight');
    await ctx.frame();
    const volAfterRight = await vol();
    await page.keyboard.press('ArrowRight');
    await ctx.frame();
    const volAtCeiling = await vol();
    // HAND IT BACK: the level to its default, the key to its absence (the default
    // is the absence of a key — core/prefs.ts), and the panel to its opening tab
    // so the escape section below starts where a player would.
    await ctx.ev(() => document.querySelector('.bs-pause [data-vol="80"]')?.click());
    await ctx.frame();
    await ctx.ev(() => localStorage.removeItem('game.settings.gameplay.volume'));
    await ctx.ev(() => document.querySelector('.bs-pause [data-tab="gameplay"]')?.click());
    await ctx.frame();

    ctx.res.volume = { volStops, volAfterRight, volAtCeiling };
    // The volume levels are one control and MUTE is beside it, not in it.
    ctx.check(JSON.stringify(volStops) === JSON.stringify(['0', '80']),
      `the music row's stops are ${JSON.stringify(volStops)}, expected OFF and the lit level`);
    ctx.check(volAfterRight.lit === '100' && volAfterRight.stored === '1',
      `right on the volume strip gave ${volAfterRight.lit} / ${volAfterRight.stored}`);
    ctx.check(volAfterRight.focus === '100',
      'and the cursor followed the value rather than being dropped');
    ctx.check(volAtCeiling.lit === '100',
      `the volume strip wrapped past its top instead of clamping (${volAtCeiling.lit})`);
  } },

  // -------------------------------------------------------------------------
  { id: 'escapeContinue', run: async (ctx) => {
    // Escape means "up one", not "close": that is what makes one key both the way
    // in and the whole way out. SIM-side, so `adv` consumes the edge.
    const { page } = ctx;
    await page.keyboard.press('Escape');
    await ctx.adv(0.4);
    const escapeFromSettings = {
      stillOpen: await has(page, '.bs-pause'),
      backOnTheList: await has(page, '.bs-pause [data-act="exit"]'),
      // Coming out of a submenu leaves the cursor where you went in.
      focus: await ctx.ev(() => document.activeElement?.getAttribute('data-act') ?? null),
    };

    await ctx.ev(() => document.querySelector('.bs-pause [data-act="continue"]')?.click());
    // WAIT FOR IT TO BE GONE, not for a frame: the next F10 anywhere downstream
    // goes through simulate()'s modal branch, and on a still-closing menu it
    // would close THIS instead of opening one.
    await ctx.waitFn(() => !document.querySelector('.bs-pause'), 5000);
    const closedByContinue = !(await has(page, '.bs-pause'));
    const travelAfterContinue = await walk(page);

    ctx.res.escapeContinue = { escapeFromSettings, closedByContinue, travelAfterContinue };
    ctx.check(escapeFromSettings.stillOpen && escapeFromSettings.backOnTheList,
      'Escape backs out of Settings rather than closing');
    ctx.check(escapeFromSettings.focus === 'settings', 'and leaves the cursor where it went in');
    ctx.check(closedByContinue, 'Continue closes the menu');
    ctx.check(travelAfterContinue > 4, 'Continue gives the game back');
  } },

  // -------------------------------------------------------------------------
  // Arm 1b: A POINTER THE BROWSER TOOK IS A POINTER, NOT A MENU
  //
  // REALTIME, unavoidably: Chrome's ~1.25 s refusal window after a lock is
  // given up (RELOCK_WAIT_MS in core/input.ts) and the asynchronous landing of
  // requestPointerLock are wall-clock behaviour of the BROWSER, which
  // `__dbgAdvance` cannot age. Every sleep below is waiting on Chrome, not on
  // the simulation.
  //
  // THIS ARM USED TO ASSERT THE OPPOSITE, and the inversion is the change. While
  // the menu was on Escape, a page holding pointer lock was never GIVEN that key
  // — the browser spends it on the lock — so the loss WAS the press, and the game
  // tapped a virtual Escape to recover the edge. With the menu on F10 there is no
  // missing edge left to reconstruct, and reconstructing one anyway is how a
  // player who pressed Escape to close a panel got a menu they never asked for.
  //
  // So: losing the pointer must raise NOTHING, and the pointer must come back
  // when the player moves (core/input.ts, `armRelock`). `document.exitPointerLock()`
  // from the page is exactly what the browser does to that lock and is how this is
  // driven — a synthetic Escape over CDP does not make the browser release
  // anything, so the state under test would never be entered.
  //
  // The Alt clause stays, and is now the same rule rather than an exception: a
  // deliberate release must neither raise a menu nor be undone by the recovery.
  // -------------------------------------------------------------------------
  { id: 'lockLost', run: async (ctx) => {
    const { page } = ctx;
    const l = {};
    // The lock is normally taken by the first click in the world; take it the same
    // way, and skip the arm rather than assert on a browser that refused.
    // At a canvas-clear point, not pinned centre — see canvasPoint.
    const spot = await canvasPoint(page);
    await page.mouse.click(spot.x, spot.y);
    await sleep(400);                  // REALTIME: the lock lands asynchronously
    l.locked = await ctx.ev(() => document.pointerLockElement !== null);
    lockGranted = l.locked;

    if (!l.locked) {
      ctx.res.lockLost = l;
      console.error('note: this browser never granted pointer lock — arms 1b/1c skipped');
      return;
    }

    await ctx.ev(() => document.exitPointerLock());
    await sleep(500);                  // REALTIME: pointerlockchange delivery
    l.menuAfterTaken = await has(page, '.bs-pause');
    l.recoveryArmed = await ctx.ev(() => window.__dbgInput().relockPending);
    // Still nothing a moment later — a menu that arrives late is the same bug.
    await sleep(700);
    l.menuStillShut = !(await has(page, '.bs-pause'));

    // MOVING IS WHAT ASKS FOR IT BACK. The wait clears Chrome's own ~1.25 s
    // refusal window after a lock is given up; see RELOCK_WAIT_MS.
    await sleep(900);                  // REALTIME: Chrome's refusal window
    await page.keyboard.down('KeyW');
    await sleep(500);                  // REALTIME: the re-request resolves async
    await page.keyboard.up('KeyW');
    l.relockedByMoving = await ctx.ev(() => document.pointerLockElement !== null);

    // Alt is a HOLD that frees the cursor deliberately: no menu, and the recovery
    // must not fight it — the pointer stays out for as long as the key is down.
    await page.keyboard.down('Alt');
    await sleep(500);                  // REALTIME
    l.menuWhileAltHeld = await has(page, '.bs-pause');
    await page.keyboard.down('KeyW');
    await sleep(600);                  // REALTIME: long enough for a wrong regrab
    await page.keyboard.up('KeyW');
    l.lockWhileAltHeld = await ctx.ev(() => document.pointerLockElement !== null);
    await page.keyboard.up('Alt');
    await sleep(400);                  // REALTIME: the retake resolves async
    l.relockedAfterAlt = await ctx.ev(() => document.pointerLockElement !== null);

    ctx.res.lockLost = l;
    // The pointer the browser TAKES is a pointer to put back, not a menu to open.
    ctx.check(l.menuAfterTaken === false,
      'a pointer lock taken away raised the menu — losing the mouse is not a request for one');
    ctx.check(l.menuStillShut, 'and none arrived late either');
    ctx.check(l.recoveryArmed, 'the loss did not arm the pointer recovery');
    ctx.check(l.relockedByMoving, 'moving did not take the pointer back');
    ctx.check(l.menuWhileAltHeld === false,
      'holding Alt frees the cursor WITHOUT raising the menu');
    ctx.check(l.lockWhileAltHeld === false,
      'the recovery grabbed the pointer back while Alt was still held');
    ctx.check(l.relockedAfterAlt, 'and releasing Alt takes the pointer back');
  } },

  // -------------------------------------------------------------------------
  // Arm 1c: A WINDOW THAT LOST FOCUS ASKED FOR NOTHING — issue #79
  //
  // REALTIME where it touches the lock (same browser machinery as arm 1b); the
  // travel measurement in the middle is simulated, because "was he simulated at
  // all" is a property of the SIM and advances fine.
  //
  // The browser drops pointer lock on an alt-tab, on a click into another window
  // and on a notification stealing focus. While the menu was on Escape, every one
  // of those looked exactly like a press: the game paused itself behind the
  // player's back and they came back to a menu they never opened. No menu is
  // raised by any lock loss now (see arm 1b), so what this arm still guards is the
  // OTHER half of the same distinction — an alt-tab must not arm the pointer
  // recovery either, or the game grabs the mouse back off whatever the player
  // switched to the moment they touch a key.
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
  // must still raise the menu... arm the recovery, or this whole arm passes
  // against a build with the hook simply deleted — which is arm 1b's feature.
  // -------------------------------------------------------------------------
  { id: 'unfocused', run: async (ctx) => {
    if (!lockGranted) { ctx.res.unfocused = { skipped: 'no pointer lock' }; return; }
    const { page } = ctx;
    const u = {};
    // BACK TO THE START POSE first — COMPOSITION FIX. The walks of the arms
    // above accumulate along `start.yaw`, and on the suite's shared page the
    // exact path drifts with the world state earlier modules left (camera
    // smoothing history, slice alignment): measured once with inventory ahead
    // of this module, the hero ended WEDGED on camp geometry at y=12 where a
    // held W moved him exactly 0.0 — and `travelAfterBlur` then read a stuck
    // hero as "losing focus paused the game". A teleport to the pose every
    // walk in this file is written against makes the measurement his, not the
    // terrain's. It moves neither the pointer lock nor the focus latches.
    const start = await ctx.ev(() => window.__dbgStart().start);
    await ctx.tp(start.x, start.z);
    await ctx.settleStreaming(10);
    const relock = async () => {
      // REALTIME guard: Chrome refuses a retake for ~1.25 s after a release.
      // RETRIED — COMPOSITION FIX: in the suite this page carries several
      // modules of world behind it, and one fixed-sleep click per round lost
      // the lock on exactly one of the three rounds ("arm 1c could not take
      // the pointer") — the refusal window's tail lands later under load than
      // it does solo. Each attempt waits out the window, clicks, then settles
      // on the lock STATE rather than a clock; three attempts bound the cost.
      for (let attempt = 0; attempt < 3; attempt++) {
        await sleep(attempt === 0 ? 1300 : 900); // REALTIME: the refusal window
        const spot = await canvasPoint(page);    // canvas-clear, not pinned centre
        await page.mouse.click(spot.x, spot.y);
        const got = await page.waitForFunction(
          () => document.pointerLockElement !== null, { timeout: 1200 },
        ).then(() => true).catch(() => false);
        if (got) {
          // REALTIME: let Input's own pointerlockchange handler process the
          // acquire before a caller releases it again — returning on the raw
          // DOM state alone made the control's instant exitPointerLock() race
          // the handler, and the release of a lock the game never saw taken
          // arms nothing.
          await sleep(300);
          return true;
        }
      }
      return false;
    };
    // Arm 1b leaves the pointer locked; read that rather than clicking again.
    u.locked = await ctx.ev(() => document.pointerLockElement !== null) || await relock();

    // 1. blur, then the lock — the alt-tab, in the order a browser sends it.
    await ctx.ev(() => {
      window.dispatchEvent(new FocusEvent('blur'));
      document.exitPointerLock();
    });
    await sleep(600);                  // REALTIME: pointerlockchange delivery
    u.menuAfterBlur = await has(page, '.bs-pause');
    // AND NO RECOVERY ARMED: the player is not here, and the pointer is not ours
    // to take back. This is the reading that replaced "did a menu open".
    u.armedAfterBlur = await ctx.ev(() => window.__dbgInput().relockPending);
    // AND NOTHING PAUSED. `walk` re-aims and holds W, so this is the same
    // measurement `travelWithMenuUp` makes and the opposite expectation —
    // simulated, because the sim is exactly what must not have stopped.
    u.travelAfterBlur = await walk(page);

    // 2. the lock, then the blur — the same loss with the events transposed.
    await ctx.ev(() => window.dispatchEvent(new FocusEvent('focus')));
    u.relocked = await relock();
    await ctx.ev(() => {
      // An own property shadowing Document.prototype.hasFocus, so the `delete`
      // below puts the real one back rather than leaving a liar on the page.
      document.hasFocus = () => false;
      document.exitPointerLock();
    });
    await sleep(600);                  // REALTIME
    u.menuAfterLockFirst = await has(page, '.bs-pause');
    u.armedAfterLockFirst = await ctx.ev(() => window.__dbgInput().relockPending);
    await ctx.ev(() => { delete document.hasFocus; });

    // 3. THE CONTROL, and it is not optional: with focus HELD the same loss must
    // arm the recovery. Without it this arm passes against a build where nothing
    // is ever armed at all — which is arm 1b's feature deleted.
    u.relockedForControl = await relock();
    await ctx.ev(() => document.exitPointerLock());
    // Settle on STATE with a realtime bound — COMPOSITION FIX: the arming
    // rides Chrome's async pointerlockchange, and under suite load the fixed
    // 600 ms sleep here read the flag before the event landed (the CONTROL
    // "armed nothing" failure). The wait targets the EXPECTED value and the
    // read below still fails honestly if it never arrives.
    await page.waitForFunction(
      () => window.__dbgInput().relockPending === true, { timeout: 2500 },
    ).catch(() => {});
    u.armedWithFocusHeld = await ctx.ev(() => window.__dbgInput().relockPending);

    // HAND THE POINTER BACK RELEASED AND UNARMED: the control above left the
    // recovery armed, so the next module's first movement key would grab the
    // mouse. A blur-shaped release disarms it (that is assertion 1), and a focus
    // event puts the latch back.
    await sleep(1400);                 // REALTIME: past the refusal window
    await page.keyboard.down('KeyW');
    await sleep(400);                  // REALTIME: let the armed recovery fire
    await page.keyboard.up('KeyW');
    await ctx.ev(() => {
      window.dispatchEvent(new FocusEvent('blur'));
      document.exitPointerLock();
    });
    await sleep(400);                  // REALTIME
    await ctx.ev(() => window.dispatchEvent(new FocusEvent('focus')));

    ctx.res.unfocused = u;
    // Issue #79. Skipped along with 1b, and for the same reason.
    ctx.check(u.locked && u.relocked && u.relockedForControl,
      'arm 1c could not take the pointer for one of its three rounds');
    ctx.check(u.menuAfterBlur === false,
      'losing window focus raised the in-game menu — an alt-tab is not a key press');
    ctx.check(u.armedAfterBlur === false && u.armedAfterLockFirst === false,
      'an alt-tab armed the pointer recovery — the game would grab the mouse back off '
      + 'whatever the player switched to');
    ctx.check(u.armedWithFocusHeld === true,
      'the CONTROL failed: a lock taken with focus held armed nothing, so the two '
      + 'assertions above pass against a build with the recovery deleted');
    // A LOOSER BOUND THAN THE `> 4` EVERY OTHER TRAVEL IN THIS FILE USES, on
    // purpose. Those ask "did the hero walk properly"; this one asks only "was he
    // simulated AT ALL", and the frozen reading is `travelWithMenuUp` above —
    // exactly 0, because a modal skips the simulation rather than slowing it. The
    // margin survives the conversion: the hold is simulated seconds now, so the
    // machine's load no longer moves it, but the bound keeps its old meaning.
    ctx.check(u.travelAfterBlur > 2,
      `the hero travelled ${u.travelAfterBlur} after a focus loss — losing `
      + 'focus must not pause the game');
    ctx.check(u.menuAfterLockFirst === false,
      'a lock dropped before the blur event landed raised the menu — the live '
      + 'hasFocus() read is what covers that order');
  } },

  // -------------------------------------------------------------------------
  // Arm 2: START, ON A PAD, COUNTED ONCE
  //
  // A PRIVATE PAGE, because `installFakePad` works through
  // `evaluateOnNewDocument` — the fake must exist before any module loads, and
  // the shared page has long since booted. The holds are SIMULATED:
  // `__dbgAdvance` polls the pad once per slice, exactly as the real loop polls
  // it once per frame, so "held across many polls" is held across many slices.
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
  // -------------------------------------------------------------------------
  { id: 'gamepadStart', run: async (ctx) => {
    const bctx = await ctx.page.browser().createBrowserContext();
    try {
      const page = await newPage(bctx, { width: 1100, height: 700 });
      logPageErrors(page);
      await installFakePad(page, 'Xbox 360 Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)');
      await page.goto(`${HOST}/?menu=0&fs=0`, { waitUntil: 'load' });
      await page.waitForSelector('canvas');
      await page.waitForFunction(
        () => window.__dbgBoot && window.__dbgBoot().playing && window.__dbgAdvance,
        { timeout: 60000 },
      );
      await page.evaluate(() => window.__connectPad());
      await advance(page, 0.3);

      const g = {};
      // HELD across many polls, then released.
      await setPadButton(page, PAD_BUTTON.START, true);
      await advance(page, 0.9);
      g.openWhileHeld = await has(page, '.bs-pause');
      await setPadButton(page, PAD_BUTTON.START, false);
      await advance(page, 0.4);
      g.openAfterRelease = await has(page, '.bs-pause');

      // And again: the same press has to close it, once.
      await setPadButton(page, PAD_BUTTON.START, true);
      await advance(page, 0.9);
      await setPadButton(page, PAD_BUTTON.START, false);
      await advance(page, 0.4);
      g.closedBySecondPress = !(await has(page, '.bs-pause'));

      // Third press reopens — proving the edge history survived a modal round trip
      // rather than the menu simply having got stuck shut.
      await setPadButton(page, PAD_BUTTON.START, true);
      await advance(page, 0.9);
      await setPadButton(page, PAD_BUTTON.START, false);
      await advance(page, 0.4);
      g.reopenedByThirdPress = await has(page, '.bs-pause');

      ctx.res.gamepad = g;
      ctx.check(g.openWhileHeld, 'Start opens the menu');
      // The one that fails on the double edge: the menu has to still be there when the
      // button comes up, not have been closed by a second edge off the same press.
      ctx.check(g.openAfterRelease, 'and one press of Start is ONE edge');
      ctx.check(g.closedBySecondPress, 'a second press closes it');
      ctx.check(g.reopenedByThirdPress, 'and a third reopens it');
    } finally {
      await bctx.close();
    }
  } },

  // -------------------------------------------------------------------------
  // Arm 3: Exit, which needs a title screen to come back to
  //
  // A PRIVATE PAGE, twice over: `StartMenu.offer` refuses to build a title
  // screen under `menu=0` — which is not a wrinkle to work around, it is the
  // flag doing exactly its job — so this arm boots WITHOUT it and walks the
  // STAGED boot: press-any-key, New Game, play, F10, Exit, and then round again
  // to prove the second game is a game and not a husk. And exiting to title on
  // the SHARED page would strand every module after this one at the menu.
  // The walks and settles are simulated (`advance`); the staged boot itself and
  // one pointer-release read stay realtime, and say so where they do.
  // -------------------------------------------------------------------------
  { id: 'exitTitle', run: async (ctx) => {
    const bctx = await ctx.page.browser().createBrowserContext();
    try {
      const page = await newPage(bctx, { width: 1100, height: 700 });
      logPageErrors(page);
      const settle = async (maxS = 30) => {
        for (let i = 0; i < maxS * 2; i++) {
          if (await page.evaluate(() => !!window.__dbgZone && !window.__dbgZone().streaming)) return true;
          await advance(page, 0.5);
        }
        return false;
      };
      await page.goto(`${HOST}/?fs=0`, { waitUntil: 'load' });
      await page.waitForSelector('canvas');
      // Through the staged boot: any key leaves the splash, then New Game.
      //
      // `leaveSplash` rather than one press, and the `?.` below is why it matters
      // most here: a dropped press left the button absent, the optional call then
      // did NOTHING, and this section went on to measure a game that had never
      // started. See tools/browser.mjs. (Realtime inside, unavoidably — it is
      // the real boot being walked.)
      await leaveSplash(page);
      await page.evaluate(() => document.querySelector('.bs-menu [data-act="new"]')?.click());
      await page.waitForFunction(
        () => window.__dbgBoot && window.__dbgBoot().playing && window.__dbgAdvance,
        { timeout: 60000 },
      );
      await settle();
      const exit = {};
      exit.playingFirst = !(await has(page, '.bs-menu'));
      exit.travelFirstGame = await walk(page);

      // Make the session distinguishable from a fresh one, so "it reset" is a
      // measurement rather than a coincidence: stand somewhere the spawn is not.
      await page.evaluate(() => {
        const p = window.__dbgPlayerPos();
        window.__dbgTp(p.x + 30, p.z + 30);
      });
      await advance(page, 0.6);
      const away = await pos(page);
      // WHERE A SESSION BEGINS, which is no longer `__dbgTowns().spawn`: that is the
      // world's reference point out on the road, and the hero now starts beside the
      // camp fire (World.playerStart). The question this section asks is "did New
      // Game put a FRESH hero on screen, or hand back the one who wandered off",
      // and only the start pose can answer it.
      const spawn = await page.evaluate(() => window.__dbgStart().start);
      exit.movedAwayFromSpawn = round(Math.hypot(away.x - spawn.x, away.z - spawn.z));

      await page.keyboard.press('F10');
      await advance(page, 0.4);
      await page.waitForSelector('.bs-pause', { timeout: 5000 });
      await page.evaluate(() => document.querySelector('.bs-pause [data-act="exit"]')?.click());
      await page.waitForSelector('.bs-menu', { timeout: 10000 });
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
      // REALTIME: the late landing being guarded against is a wall-clock moment.
      await sleep(1000);
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
      await page.waitForFunction(
        () => window.__dbgBoot && window.__dbgBoot().playing,
        { timeout: 60000 },
      );
      await settle();
      // Nothing of the poster may outlive the handover — not the element, and not
      // the fairies and lantern glows animating inside it. Settled on state, with
      // the timeout swallowed so a surviving poster fails the ASSERTION below
      // rather than throwing a bare timeout.
      await page.waitForFunction(() => !document.querySelector('.bs-menu'), { timeout: 8000 })
        .catch(() => {});
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

      ctx.res.exit = exit;
      ctx.check(exit.playingFirst && exit.travelFirstGame > 4,
        'the staged boot reaches a playable game');
      ctx.check(exit.movedAwayFromSpawn > 20, 'the first session was somewhere the second is not');
      ctx.check(exit.titleScreenBack && exit.pauseGone, 'Exit puts the title screen back');
      ctx.check(exit.step === 'options', 'and lands on the options, not the splash');
      ctx.check(exit.lockAtTitle === null,
        `the pointer is given back at the title screen (locked to ${exit.lockAtTitle})`);
      ctx.check(exit.secondGame.menuGone, 'New Game works a second time, from a real mouse click');
      ctx.check(exit.secondGame.fromSpawn < 3, 'and the second hero starts at the opening pose');
      ctx.check(exit.secondGame.travel > 4, 'and can walk');
      // Belt and braces on the same handover: the element going is what `menuGone`
      // says, and these are the two things INSIDE it that the player actually sees.
      ctx.check(exit.posterRemnants.menus === 0, 'no poster survives the second handover');
      ctx.check(exit.posterRemnants.flies === 0 && exit.posterRemnants.lamps === 0,
        `no fairies or lantern glows left over (${exit.posterRemnants.flies} flies, ` +
        `${exit.posterRemnants.lamps} lamps)`);
    } finally {
      await bctx.close();
    }
  } },
];

if (import.meta.main) {
  const { soloRun } = await import('./suite/harness.mjs');
  await soloRun({ name, sections });
}
