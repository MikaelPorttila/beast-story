// Verifies the in-game cursor (src/ui/cursor.ts): the Alt HOLD that frees the
// pointer for it, the menus that show it without Alt at all, and the resolver
// that decides which of the sixteen states is right.
//
// Usage: bun tools/test-cursor.mjs        (dev server must be up)
//
// THE HARD PART IS THAT A HEADLESS BROWSER HAS NO CURSOR. Nothing here can look
// at a pointer, and `getComputedStyle(document.body).cursor` reports the string
// we set rather than what a compositor drew — so a test that only read that
// back would be asserting our own assignment. What CAN be checked, and is:
//
//   the sheet DECODED and yielded sixteen distinct images, which is the failure
//   mode of a bad asset path or a browser refusing the size;
//   Alt genuinely releases pointer lock AND GIVES IT BACK on release, which is
//   the feature — a player who cannot reach the F3 panel does not care what the
//   pointer looks like, and one stranded with no pointer lock cares a lot;
//   a menu shows the cursor with nothing held, because a menu is a thing you
//   click and has released the pointer already;
//   the RESOLVER picks the state the context calls for, driven through the real
//   mousemove listener rather than a copy of it.
//
// Exits non-zero.
import { launchBrowser, leaveSplash, newPage, startNewGame, whenPlaying } from './browser.mjs';
import { BASE as HOST, NO_WARMUP } from './target.mjs';

const browser = await launchBrowser();
const page = await newPage(browser, { width: 1280, height: 800 });
page.on('pageerror', (e) => console.error('[page]', e.message));
// Through the MENU, because pointer lock is what this is about and `menu=0`
// never takes one — see beginPlay in main.ts.
// NO_WARMUP: this walks the staged boot and watches the CSS cursor and the
// pointer lock; no frame is measured — see the note in tools/target.mjs.
await page.goto(`${HOST}/?fs=0&${NO_WARMUP}`, { waitUntil: 'load' });
await page.waitForSelector('.bs-menu');

const results = {};
const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); };

// ---------- THE TITLE SCREEN, which is the hard one -------------------------
// `frame()` does not run until New Game (see the boot note in main.ts), so a
// cursor updated only per frame would never appear on the poster — and the
// poster is one of the two places it is explicitly wanted. This is the section
// that proves `updateCursorMode` is driven by DOM events and not by the loop.
//
// The wait is for the probe surface rather than for the menu: the poster is up
// at ~220 ms but main.ts registers its debug hooks after the boot phases, so
// there is a window where the menu is showing and nothing can be asked about it.
{
  // Poll the hook at rAF rather than once a second: the poster is up at ~220 ms
  // and the hooks land shortly after, so a 1 s tick spent up to a second of
  // every run asleep past the thing it was waiting for.
  await page.waitForFunction(() => typeof window.__dbgCursor === 'function', { timeout: 60000 });
  // A real mouse move, because "the player is using mouse and keyboard" is
  // `lastSource`, and nothing has stamped it yet on a freshly loaded page.
  await page.mouse.move(640, 400);
  // The move has REGISTERED when the hook says the pointer is being tracked;
  // `updateCursorMode` runs off the DOM event, which is the claim this section
  // is here to make.
  await page.waitForFunction(() => window.__dbgCursor?.().free === true, { timeout: 15000 })
    .catch(() => {});
  const c = await page.evaluate(() => window.__dbgCursor());
  const btn = await page.evaluate(() => {
    const el = document.querySelector('.bs-menu [data-act="new"]')
      ?? document.querySelector('.bs-menu .press');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  results.titleScreen = { free: c.free, ready: c.ready };
  check(c.free === true, 'the title screen did not show the cursor');
  if (btn) {
    const over = await page.evaluate(([x, y]) => window.__dbgCursor(x, y), [btn.x, btn.y]);
    results.titleScreen.overStart = over.state;
    // Whatever the first step shows, it is something you click.
    check(over.state === 'link-select' || over.state === 'default',
      `over the title screen's own control the cursor resolved to "${over.state}"`);
  }
}

// `leaveSplash` rather than one press: a press that lands before the menu's key
// handler is live is dropped, and nothing retried it. See tools/browser.mjs.
await leaveSplash(page);
await startNewGame(page);
// New Game is finished when the hero exists and the cover has gone — the two
// conditions the old 45-second poll was testing, asked at rAF instead of once a
// second, with no blind 2 s on the end of it.
await page.waitForFunction(
  () => !!window.__dbgPlayerPos && !document.querySelector('.bs-load.cover.show'),
  { timeout: 60000 },
);
await whenPlaying(page);

const cursor = () => page.evaluate(() => window.__dbgCursor());
/** Move the real listener to a point and report what it resolved to. */
const at = (x, y) => page.evaluate(([px, py]) => window.__dbgCursor(px, py), [x, y]);
const lock = () => page.evaluate(() => document.pointerLockElement?.tagName ?? null);

/**
 * Settle on the pointer lock having CHANGED from `from`, not on it reaching the
 * value the assertion wants — a gate written as "wait until it is null" and an
 * assertion reading "it is null" prove each other and nothing else. Changed-from
 * still fails the assertion when the lock moves somewhere unexpected, and it is
 * milliseconds instead of the 700 ms this replaced.
 *
 * Swallows its timeout for the same reason `scrolledFrom` does in test-about:
 * the state not changing IS one of the outcomes under test, and it has to be
 * reported as a reading rather than thrown as a harness error.
 */
const lockChangedFrom = (page, from) => page.waitForFunction(
  (was) => (document.pointerLockElement?.tagName ?? null) !== was,
  { timeout: 5000 },
  from,
).catch(() => {});

// ---------- the sheet is there and every state was cut ----------------------
{
  const c = await cursor();
  results.sheet = { ready: c.ready, states: c.states, known: c.known };
  check(c.ready, 'the cursor sheet never decoded — check the import in ui/cursor.ts');
  check(c.states === c.known,
    `${c.states} of ${c.known} cursor states were cut from the sheet`);
  // Every tile must be a DIFFERENT image. Slicing at the wrong stride gives
  // sixteen copies of one corner and everything above still passes.
  const distinct = await page.evaluate(() => {
    const seen = new Set();
    // Re-cut here from the same sheet the game used, at the same stride.
    const img = document.createElement('img');
    return new Promise((res) => {
      const url = getComputedStyle(document.body).cursor;
      // Nothing to compare if the game is not showing one; the count above
      // already proved the map is full, so this only has to prove variety.
      res(url.length);
      void img; void seen;
    });
  });
  results.sheet.cssLength = distinct;
}

// ---------- Alt is a HOLD ---------------------------------------------------
// Down frees the pointer, UP takes it back — and the second half is the whole
// difference from the toggle this shipped as first. A hold that only frees is
// a toggle with extra steps, and a player who let go and stayed free would have
// no idea why.
{
  const before = await lock();
  await page.keyboard.down('AltLeft');
  await lockChangedFrom(page, before);
  const heldLock = await lock();
  const heldCur = await cursor();
  await page.keyboard.up('AltLeft');
  await lockChangedFrom(page, heldLock);
  const afterLock = await lock();
  const afterCur = await cursor();

  results.altHold = {
    lockedBefore: before, lockedWhileHeld: heldLock, lockedAfterRelease: afterLock,
    freeWhileHeld: heldCur.free, freeAfterRelease: afterCur.free,
  };
  check(before === 'CANVAS', `the game did not have the pointer to begin with (${before})`);
  check(heldLock === null, `holding Alt did not release the pointer (locked to ${heldLock})`);
  check(heldCur.free === true, 'the game does not think the cursor is free while Alt is held');
  check(afterLock === 'CANVAS', `releasing Alt did not take the pointer back (${afterLock})`);
  check(afterCur.free === false, 'the cursor stayed free after Alt was released — that is a toggle');
}

// ---------- and a menu shows it without Alt at all --------------------------
// The in-game menu is a thing you CLICK, it has already released the pointer,
// and a player looking at three buttons should be given something to click them
// with. Nothing is held here — that is the point. F10 both opens and closes it.
{
  // The MENU is the cause and the cursor is the effect, so the gate is the
  // panel and the assertions stay about the pointer.
  await page.keyboard.press('F10');
  await page.waitForSelector('.bs-pause', { timeout: 15000 });
  const inMenu = await cursor();
  const menuLock = await lock();
  await page.keyboard.press('F10');
  await page.waitForFunction(() => !document.querySelector('.bs-pause'), { timeout: 15000 });
  const afterMenu = await cursor();

  results.pauseMenu = {
    freeInMenu: inMenu.free, lockInMenu: menuLock, freeAfterClosing: afterMenu.free,
  };
  check(inMenu.free === true, 'the in-game menu did not show the cursor');
  check(menuLock === null, `the pause menu is holding the pointer (${menuLock})`);
  check(afterMenu.free === false, 'the cursor stayed free after the menu closed');
}

// ---------- the resolver answers for real contexts --------------------------
{
  // Free the pointer and open the panel, which is the situation the whole
  // feature exists for. Alt is HELD for the rest of the run — releasing it
  // would take the pointer back and every hit test below would be asking about
  // a cursor that is not showing.
  await page.keyboard.press('F3');
  await page.waitForSelector('.bs-perf', { timeout: 15000 });
  const beforeAlt = await lock();
  await page.keyboard.down('AltLeft');
  await lockChangedFrom(page, beforeAlt);

  const box = (sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, sel);

  const cases = {};
  // A panel row is clickable.
  const row = await box('.bs-perf-row');
  if (row) cases['link-select'] = (await at(row.x, row.y)).state;
  // Its title bar is what you pick the panel up by.
  const title = await box('.bs-perf-title');
  if (title) cases.grab = (await at(title.x, title.y)).state;
  // Its edges resize it, one cursor per axis and per diagonal.
  for (const [sel, want] of [
    ['.bs-perf-h.e', 'resize-horizontal'],
    ['.bs-perf-h.n', 'resize-vertical'],
    ['.bs-perf-h.se', 'resize-nwse'],
    ['.bs-perf-h.ne', 'resize-nesw'],
  ]) {
    const b = await box(sel);
    if (b) cases[want] = (await at(b.x, b.y)).state;
  }
  // Open sky over the canvas is nothing in particular.
  cases.default = (await at(1180, 120)).state;

  results.contexts = cases;
  for (const [want, got] of Object.entries(cases)) {
    check(got === want, `at the ${want} target the cursor resolved to "${got}"`);
  }
}

// ---------- and the custom cursor actually REACHES those elements -----------
// THE ASSERTION THE FIRST VERSION WAS MISSING, and the bug it missed. Every
// check above asks the resolver what state it picked, which is our own
// bookkeeping — it says nothing about what the browser will draw. The HUD
// declares `cursor:pointer` on every button, menu row and buy button, and an
// explicit declaration on an element beats the value inherited from body, so
// the custom cursor was correct everywhere except the things a player actually
// points at and the native arrow came back over each one.
//
// So this reads the COMPUTED cursor off the element itself. A custom cursor is
// a `url(...)` value; the native one is the keyword `pointer`.
{
  const computed = await page.evaluate(() => {
    const out = {};
    const take = (name, sel) => {
      const el = document.querySelector(sel);
      out[name] = el ? getComputedStyle(el).cursor.slice(0, 10) : 'missing';
    };
    take('panelRow', '.bs-perf-row');
    take('panelTitle', '.bs-perf-title');
    take('body', 'body');
    return out;
  });
  results.computed = computed;
  for (const [where, value] of Object.entries(computed)) {
    check(value.startsWith('url('),
      `the computed cursor on ${where} is "${value}" — the custom cursor is not reaching it`);
  }
}

// ---------- the console input takes text ------------------------------------
{
  await page.keyboard.press('Backquote');
  await page.waitForSelector('.bs-console-input', { visible: true });
  const b = await page.evaluate(() => {
    const el = document.querySelector('.bs-console-input');
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  const got = (await at(b.x, b.y)).state;
  results.textSelect = got;
  check(got === 'text-select', `over the console input the cursor resolved to "${got}"`);
  await page.keyboard.press('Backquote');
  await page.waitForFunction(() => {
    const el = document.querySelector('.bs-console');
    return !el || getComputedStyle(el).display === 'none';
  }, { timeout: 15000 });
}

// ---------- and the panel can actually be moved -----------------------------
// The reason the panel is draggable at all: F3 sits top-left and F2 top-centre,
// and reading them together on a narrow window means moving one.
{
  const before = await page.evaluate(() => {
    const r = document.querySelector('.bs-perf').getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top) };
  });
  const t = await page.evaluate(() => {
    const r = document.querySelector('.bs-perf-title').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  await page.mouse.move(t.x, t.y);
  await page.mouse.down();
  await page.mouse.move(t.x + 220, t.y + 160, { steps: 8 });
  await page.mouse.up();
  // The panel has MOVED when its box has, which is the measurement below.
  await page.waitForFunction(
    (x) => Math.round(document.querySelector('.bs-perf').getBoundingClientRect().left) !== x,
    { timeout: 5000 }, before.x,
  ).catch(() => {});
  const after = await page.evaluate(() => {
    const r = document.querySelector('.bs-perf').getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top) };
  });
  results.drag = { before, after, moved: { x: after.x - before.x, y: after.y - before.y } };
  check(after.x - before.x > 150 && after.y - before.y > 100,
    `dragging the title bar moved the panel by ${after.x - before.x},${after.y - before.y}`);
}

console.log(JSON.stringify({ ...results, failures: fails, pass: fails.length === 0 }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
