// Shared browser harness for every tool in this directory.
//
// We drive a Chromium-family browser that is already installed on the machine
// (Brave here) through puppeteer-core. Two constraints forced this shape:
//
//   * Playwright cannot talk to any browser from the Bun runtime — its
//     --remote-debugging-pipe handshake never answers on fd 4, and
//     connectOverCDP() times out even though a raw WebSocket to the same
//     endpoint replies fine. puppeteer-core works under Bun.
//   * puppeteer-CORE ships no browser of its own, which is what we want: no
//     100 MB download, just the browser that is already here.
//
// BROWSER_EXECUTABLE is a per-machine setting — keep it in `.env.local`
// (gitignored, auto-loaded by Bun), never in committed config. See .env.example.
//
// GPU: headless Brave uses hardware acceleration when available if we pass NO GL
// flags. Earlier revisions forced `--use-angle=swiftshader`, which rasterised the
// whole scene on the CPU — far slower per frame, and the source of the CPU spikes
// during test runs. Do not reintroduce those flags as a default; a host without a
// usable GPU sets SOFTWARE_GL=1 to fall back to CPU rendering deliberately.
// glRenderer() below reports which path a run actually got.
import puppeteer, { KnownDevices } from 'puppeteer-core';

// --ignore-gpu-blocklist is a no-op on a healthy driver (measured: identical
// renderer and timing with and without it) but rescues the GPU path on hosts
// where headless Chromium blocklists the adapter.
const GPU_ARGS = ['--ignore-gpu-blocklist', '--enable-gpu-rasterization'];
const SOFTWARE_GL_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'];
const GL_ARGS = process.env.SOFTWARE_GL === '1' ? SOFTWARE_GL_ARGS : GPU_ARGS;

// Brave-specific noise suppression: a fresh profile otherwise pulls its
// component updates and Rewards machinery into the run we are timing.
const BRAVE_ARGS = ['--disable-brave-update', '--disable-sync', '--disable-component-update'];

const PHONE = KnownDevices['Pixel 5'];

export async function launchBrowser({ args = [] } = {}) {
  // A batch run (tools/probe.mjs) starts ONE browser and names it here, so the
  // probes inside it skip a ~1 s launch each. `close()` is remapped to
  // `disconnect()` because every probe ends by closing "its" browser and the
  // next one in the batch still needs this to be alive. Note the launch `args`
  // are ignored on this path by construction — a probe needing its own flags
  // must not join the shared browser, which is why probe.mjs keeps a
  // per-probe `solo` list rather than hoping.
  const ws = process.env.BS_BROWSER_WS?.trim();
  if (ws) {
    const shared = await puppeteer.connect({ browserWSEndpoint: ws });
    shared.close = shared.disconnect.bind(shared);
    return shared;
  }
  const executablePath = process.env.BROWSER_EXECUTABLE?.trim();
  if (!executablePath) {
    throw new Error(
      'BROWSER_EXECUTABLE is not set. Copy .env.example to .env.local and point it at ' +
      'your Chromium-family browser (Brave/Chrome/Edge) — Bun loads .env.local automatically.',
    );
  }
  const isBrave = /brave/i.test(executablePath);
  return puppeteer.launch({
    executablePath,
    headless: true,
    args: [...GL_ARGS, ...(isBrave ? BRAVE_ARGS : []), ...args],
    timeout: 30000,
  });
}

// `target` is a Browser or a BrowserContext — both expose newPage().
// `phone: true` emulates the Pixel 5 (touch + mobile UA) at the given size,
// which is what the touch/layout tools need.
export async function newPage(target, { width, height, deviceScaleFactor = 1, phone = false } = {}) {
  const page = await target.newPage();
  if (phone) await page.setUserAgent(PHONE.userAgent);
  await page.setViewport({
    width, height, deviceScaleFactor,
    isMobile: phone, hasTouch: phone, isLandscape: phone && width > height,
  });
  return page;
}

// A fresh context per case keeps saved progress in localStorage from leaking
// between measurements, the way Playwright's per-context isolation did.
export async function newContextPage(browser, opts) {
  const ctx = await browser.createBrowserContext();
  return { ctx, page: await newPage(ctx, opts) };
}

// puppeteer dropped page.waitForTimeout(); these runs are frame-rate bound, so
// waiting a wall-clock interval is exactly what we want.
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export const count = async (page, sel) => (await page.$$(sel)).length;

/**
 * Get past the title screen's "Press start..." step, and DO NOT TAKE ONE PRESS
 * FOR AN ANSWER.
 *
 * The staged boot is `waitForSelector('.bs-menu')`, a keypress to leave the
 * splash, then the options buttons. Nine probes wrote that out by hand and all
 * nine pressed exactly once — which is a race, because `.bs-menu` is in the DOM
 * before the menu's key handler is live. A press that lands in that window is
 * dropped, nothing retries it, and the screen sits on the splash forever: the
 * probe then dies waiting for a New Game button that is never going to be
 * built.
 *
 * IT IS A REAL FLAKE AND IT WAS BLAMED ON THREE OTHER THINGS FIRST — a
 * hot-reload from editing src/ mid-run, then leaked pages starving the tab of
 * frames, then focus. Measured, the page is `visible`, gets 166 rAF callbacks a
 * second, and fails identically with `bringToFront()`; and `dive` still failed
 * starting on a browser with exactly one page. What fixed it was pressing
 * again: the second press always lands. The window widens with load, which is
 * why it shows up in a batch and not in a probe run on its own.
 *
 * Polls for the BUTTON rather than for a step attribute, because the button is
 * what every caller actually wants next, and it cannot appear until the menu
 * has genuinely advanced.
 */
export async function leaveSplash(page, { timeout = 20000, key = 'Enter' } = {}) {
  await page.waitForSelector('.bs-menu', { timeout });
  const deadline = Date.now() + timeout;
  for (let presses = 1; ; presses++) {
    if (await page.$('.bs-menu [data-act]')) return presses - 1;
    if (Date.now() > deadline) {
      throw new Error(
        `the title screen never left its splash step after ${presses} presses of ${key}`,
      );
    }
    await page.keyboard.press(key);
    await wait(300);
  }
}

// Which GL path did we actually get? Use this in perf-sensitive tools so a
// silent fall back to CPU rasterisation is visible in the output.
export const glRenderer = (page) => page.evaluate(() => {
  const g = document.createElement('canvas').getContext('webgl2');
  const d = g?.getExtension('WEBGL_debug_renderer_info');
  return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : '(unknown)';
});

export const isVisible = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return false;
  const st = getComputedStyle(el);
  if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}, sel);

export const logPageErrors = (page) => {
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
};

/**
 * SYNTHETIC GAMEPAD, shared by every probe that needs one.
 *
 * Lives here rather than in one test because two now need it, and the second
 * (test-pause.mjs) exists to catch a pad EDGE being counted twice — the kind of
 * bug a second, slightly different copy of this harness would be perfectly
 * capable of hiding.
 *
 * A real controller cannot be plugged into headless Brave, so
 * `evaluateOnNewDocument` replaces `navigator.getGamepads` before any module
 * loads and a `gamepadconnected` event wakes the game's own listener. That runs
 * the real code path end to end and needs no test-only code in the bundle.
 *
 * The fake deliberately does NOT model `timestamp`: nothing in core/gamepad.ts
 * reads it, and a fake that pretended to would be asserting on our own mock.
 */
/** Install the fake pad. `id` decides which glyph set the HUD should choose. */
export async function installFakePad(page, id, { rumble = false } = {}) {
  await page.evaluateOnNewDocument((id, rumble) => {
    const state = {
      id,
      index: 0,
      connected: true,
      mapping: 'standard',
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    };
    if (rumble) {
      // Records calls so the mixer's re-issue cadence can be counted rather
      // than assumed. `effects` is the current spec spelling.
      window.__rumble = { calls: 0, last: null };
      state.vibrationActuator = {
        effects: ['dual-rumble'],
        playEffect: (type, params) => {
          window.__rumble.calls++;
          window.__rumble.last = { type, ...params };
          return Promise.resolve('complete');
        },
      };
    }
    window.__fakePad = state;
    navigator.getGamepads = () => [state];
    // Dispatched EXPLICITLY by the test once the game has booted, rather than
    // off `load`. main.ts is a module and the module graph is served over many
    // dev-server round-trips, so `load` is not a reliable "the game's listener
    // exists now" signal — firing there raced the listener and the pad silently
    // never connected. Chrome would fire this on the pad's first real press.
    // NOT `new GamepadEvent(...)`: its constructor performs a real conversion to
    // the platform Gamepad interface and rejects a plain object outright, and
    // there is no way to mint a genuine Gamepad from script. A plain Event with
    // the property defined on it delivers the exact shape the listener reads
    // (`e.gamepad.index`, `e.gamepad.id`), which is what is under test.
    window.__connectPad = () => {
      const ev = new Event('gamepadconnected');
      Object.defineProperty(ev, 'gamepad', { value: state });
      window.dispatchEvent(ev);
    };
  }, id, rumble);
}

/** Standard-mapping button indices, mirrored from core/gamepad.ts. */
export const PAD_BUTTON = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7,
  START: 9, L3: 10, R3: 11, DUP: 12, DDOWN: 13, DLEFT: 14, DRIGHT: 15,
};

/** Press or release one button on the fake pad. */
export const setPadButton = (page, i, down) => page.evaluate((i, down) => {
  window.__fakePad.buttons[i] = { pressed: down, touched: down, value: down ? 1 : 0 };
}, i, down);
