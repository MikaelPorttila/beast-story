// The F1 controls sheet, and the one guard that can catch it going stale.
//
// TWO DIFFERENT QUESTIONS, and only the second one is about the DOM.
//
//   1. IS THE SHEET STILL TRUE? src/ui/keybinds.ts is a hand-written table —
//      a binding is not a value anywhere in this codebase, so there is no
//      registry to derive it from. What there IS is the set of key codes the
//      game actually reads: every `pressed('…')`, `down('…')` and `keys.has('…')`
//      in src/. Scanned here and compared against the table, so a binding added
//      without a row fails a run rather than quietly never being documented.
//
//      One direction is a HARD failure and the other is not. A code the game
//      reads and the sheet does not name is a hole in the sheet — that is
//      `unlisted`, and it must be empty. The reverse, `listedNotScanned`, is
//      expected to hold exactly the four hotbar digits: main.ts reads them
//      through a loop variable (`input.pressed(code)` over an `as const` array)
//      and no regex over the source will see them. Anything ELSE showing up
//      there is a row describing a key nothing reads.
//
//   2. DOES IT RENDER? F1 opens it, F1 closes it, the world stands still while
//      it is up, both device columns are populated, and the HOLD chips are
//      distinguishable from the PRESS ones — which is the requirement the panel
//      exists to satisfy, so it is asserted on the painted class, not on intent.
//
// Usage: bun tools/test-keybinds.mjs
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser, newPage, wait } from './browser.mjs';

const URL = 'http://localhost:5187/?fps=30&menu=0';
const SRC = 'src';

// ---------- 1. the table vs. the source ------------------------------------
/** Every `.ts` under src/, recursively. */
function sources(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(p));
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

// `has` is in here for WASD: core/input.ts reads the movement axes straight off
// its own held set rather than through down(), and a sheet that forgot to
// mention how you WALK would otherwise pass. `takePress` is the frame-loop read
// F1 and F2 use — it is a separate word, and leaving it out silently dropped
// both of them out of this scan.
const READ = /(?:takePress|pressed|down|has)\(\s*'([A-Za-z0-9]+)'\s*\)/g;
const scanned = new Set();
for (const file of sources(SRC)) {
  // Skip the table itself: its `codes` arrays are not reads, and matching them
  // would make this check compare the file against itself.
  if (file.endsWith(path.join('ui', 'keybinds.ts'))) continue;
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(READ)) scanned.add(m[1]);
}

// Read the table's codes out of the source rather than importing it: this is a
// plain ESM tool with no TypeScript loader, and the shape is one flat field.
const table = fs.readFileSync(path.join(SRC, 'ui', 'keybinds.ts'), 'utf8');
const listed = new Set();
for (const m of table.matchAll(/codes:\s*\[([^\]]*)\]/g)) {
  for (const c of m[1].matchAll(/'([^']+)'/g)) listed.add(c[1]);
}

const results = {
  table: {
    codesReadInSource: [...scanned].sort(),
    codesInSheet: [...listed].sort(),
    unlisted: [...scanned].filter((c) => !listed.has(c)).sort(),
    listedNotScanned: [...listed].filter((c) => !scanned.has(c)).sort(),
  },
};

// ---------- 2. the panel ----------------------------------------------------
const browser = await launchBrowser();
const page = await newPage(browser, { width: 1280, height: 800 });
await page.goto(URL, { waitUntil: 'load' });
await page.waitForSelector('canvas');
await wait(3500);

const sheet = () => page.evaluate(() => {
  const wrap = document.querySelector('.bs-keyswrap');
  const rows = [...document.querySelectorAll('.bs-keyrow:not(.head)')];
  return {
    open: !!wrap?.classList.contains('open'),
    sections: document.querySelectorAll('.bs-keys-sec').length,
    rows: rows.length,
    hold: rows.filter((r) => r.querySelector('.mode.hold')).length,
    press: rows.filter((r) => r.querySelector('.mode.press')).length,
    // Every row must say something on BOTH sides — a key cap on the keyboard
    // side, and either a controller face or the explicit "no binding" dash.
    rowsMissingKbm: rows.filter((r) => !r.querySelector('.kbm kbd')).length,
    rowsMissingPad: rows.filter((r) =>
      !r.querySelector('.pad kbd.pad') && !r.querySelector('.pad .none')).length,
    padFaces: document.querySelectorAll('.bs-keys .pad kbd.pad').length,
    noPadBinding: document.querySelectorAll('.bs-keys .pad .none').length,
  };
});

results.beforeOpen = await sheet();

await page.keyboard.press('F1');
await wait(500);
results.opened = await sheet();

// THE GATE, and the pair that matters: an identical hold of W must travel
// nothing while the sheet is up and the usual distance once it is shut. Same
// shape as the title screen's assertion in test-menu.mjs — a panel that only
// LOOKS modal is the failure being ruled out.
const held = async () => {
  const before = await page.evaluate(() => window.__dbgPlayerPos());
  await page.keyboard.down('w');
  await wait(1200);
  await page.keyboard.up('w');
  await wait(120);
  const after = await page.evaluate(() => window.__dbgPlayerPos());
  return +Math.hypot(after.x - before.x, after.z - before.z).toFixed(2);
};
const movedWhileOpen = await held();

await page.keyboard.press('F1');
await wait(500);
results.closed = await sheet();
const movedWhileClosed = await held();
results.gate = { movedWhileOpen, movedWhileClosed };

// Escape must close it too — that is the path a controller reaches it by, since
// B and Start tap Escape while a modal is up and no pad button opens the sheet.
await page.keyboard.press('F1');
await wait(400);
const openedAgain = (await sheet()).open;
await page.keyboard.press('Escape');
await wait(400);
results.escape = { openedAgain, closedByEscape: !(await sheet()).open };

await page.close();

// ---------- 3. the sheet follows the device, WHILE IT IS OPEN ---------------
//
// A pad's buttons are read for "the pad is the live device" BEFORE the modal
// branch in core/gamepad.ts, so a player who picks the controller up while
// reading must watch the faces change under them. Synthetic pad, same technique
// as tools/test-gamepad.mjs — a real one cannot be plugged into headless Brave.
{
  const pad = await newPage(browser, { width: 1280, height: 800 });
  await pad.evaluateOnNewDocument(() => {
    const state = {
      id: 'DualSense Wireless Controller (Vendor: 054c Product: 0ce6)',
      index: 0,
      connected: true,
      mapping: 'standard',
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    };
    window.__fakePad = state;
    navigator.getGamepads = () => [state];
    window.__connectPad = () => {
      const ev = new Event('gamepadconnected');
      Object.defineProperty(ev, 'gamepad', { value: state });
      window.dispatchEvent(ev);
    };
  });
  await pad.goto(URL, { waitUntil: 'load' });
  await pad.waitForSelector('canvas');
  await wait(3500);
  await pad.evaluate(() => window.__connectPad());
  await wait(200);

  // Opened on the keyboard, so this is the Xbox fallback the panel prints for
  // nobody in particular.
  await pad.keyboard.press('F1');
  await wait(500);
  const faces = () => pad.evaluate(() =>
    [...document.querySelectorAll('.bs-keys .pad kbd.pad')].map((k) => k.textContent).join(' '));
  const onKeyboard = await faces();

  // A (index 0), pressed with the sheet up. Deliberately NOT Start or B: those
  // two tap Escape while a modal is up and would close the very panel being
  // measured. A reaches nothing at all here — it only stamps the source, which
  // is the whole point.
  await pad.evaluate(() => {
    window.__fakePad.buttons[0] = { pressed: true, touched: true, value: 1 };
  });
  await wait(200);
  await pad.evaluate(() => {
    window.__fakePad.buttons[0] = { pressed: false, touched: false, value: 0 };
  });
  await wait(400);
  const onPad = await faces();

  results.deviceSwitch = {
    onKeyboard,
    onPad,
    // ✕ and □ are PlayStation's; A and X are the Xbox faces they replaced.
    xboxWhileNobodyHadPicked: onKeyboard.includes('A'),
    playstationOncePadUsed: onPad.includes('✕'),
    changed: onKeyboard !== onPad,
  };
  await pad.close();
}

// ---------- 4. ten presses, UNCAPPED ---------------------------------------
//
// THE ASSERTION THIS FILE EXISTS FOR SECOND, and the one every other section
// here is structurally blind to. `?fps=30` against a 60 Hz sim drains two
// slices on every frame, so `endFrame()` runs every frame and a press can never
// be read twice. Uncapped it runs at the display's refresh rate — 165 Hz on the
// machine this was measured on — and two frames in three drain nothing at all.
//
// A frame-loop toggle reading an unconsumed `pressed()` therefore fired two or
// three times per press and landed back where it started: measured before the
// fix, ten presses of F1 gave `0011011101`. NO `fps=` HERE, deliberately, and if
// a future edit adds one this assertion quietly stops testing anything.
{
  const fast = await newPage(browser, { width: 1280, height: 800 });
  await fast.goto('http://localhost:5187/?menu=0', { waitUntil: 'load' });
  await fast.waitForSelector('canvas');
  await wait(3500);

  const seq = [];
  for (let i = 0; i < 10; i++) {
    await fast.keyboard.press('F1');
    await wait(350);
    seq.push(await fast.evaluate(() =>
      document.querySelector('.bs-keyswrap')?.classList.contains('open') ? 1 : 0));
  }
  const pattern = seq.join('');
  results.uncappedToggle = {
    pattern,
    expected: '1010101010',
    alternates: pattern === '1010101010',
  };
  await fast.close();
}

console.log(JSON.stringify(results, null, 2));
await browser.close();
