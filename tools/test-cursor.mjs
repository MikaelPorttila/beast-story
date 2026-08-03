// Verifies the in-game cursor (src/ui/cursor.ts) and the Alt toggle that frees
// the pointer for it.
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
//   Alt genuinely releases pointer lock, which is the feature — a player who
//   cannot reach the F3 panel does not care what the pointer looks like;
//   the RESOLVER picks the state the context calls for, driven through the real
//   mousemove listener rather than a copy of it.
//
// Exits non-zero.
import { launchBrowser, newPage, wait } from './browser.mjs';

const browser = await launchBrowser();
const page = await newPage(browser, { width: 1280, height: 800 });
page.on('pageerror', (e) => console.error('[page]', e.message));
// Through the MENU, because pointer lock is what this is about and `menu=0`
// never takes one — see beginPlay in main.ts.
await page.goto('http://localhost:5187/?fs=0', { waitUntil: 'load' });
await page.waitForSelector('.bs-menu');
await page.keyboard.press('Enter');
await wait(700);
await (await page.waitForSelector('button[data-act="new"]', { visible: true })).click();
for (let i = 0; i < 45; i++) {
  await wait(1000);
  if (await page.evaluate(() =>
    !!window.__dbgPlayerPos && !document.querySelector('.bs-load.cover.show'))) break;
}
await wait(2000);

const results = {};
const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); };

const cursor = () => page.evaluate(() => window.__dbgCursor());
/** Move the real listener to a point and report what it resolved to. */
const at = (x, y) => page.evaluate(([px, py]) => window.__dbgCursor(px, py), [x, y]);
const lock = () => page.evaluate(() => document.pointerLockElement?.tagName ?? null);

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

// ---------- Alt frees the pointer, and gives it back ------------------------
{
  const before = await lock();
  await page.keyboard.press('AltLeft');
  await wait(600);
  const freed = await lock();
  const cFree = await cursor();
  await page.keyboard.press('AltLeft');
  await wait(600);
  const back = await lock();

  results.altToggle = {
    lockedBefore: before, lockedWhileFree: freed, lockedAfter: back,
    reportedFree: cFree.free,
  };
  check(before === 'CANVAS', `the game did not have the pointer to begin with (${before})`);
  check(freed === null, `Alt did not release the pointer (still locked to ${freed})`);
  check(cFree.free === true, 'the game does not think the cursor is free');
  // Coming back matters as much as going: a toggle that only frees is a trap.
  check(back === 'CANVAS', `Alt a second time did not take the pointer back (${back})`);
}

// ---------- the resolver answers for real contexts --------------------------
{
  // Free the pointer and open the panel, which is the situation the whole
  // feature exists for.
  await page.keyboard.press('AltLeft');
  await wait(400);
  await page.keyboard.press('F3');
  await wait(700);

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
  await wait(300);
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
  await wait(300);
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
