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
