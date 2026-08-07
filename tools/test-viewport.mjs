// Verifies that every full-screen layer is cut to the VISIBLE box, in the two
// states issue #16 was reported from: a phone that has just gone fullscreen, and
// a phone that has just been rotated.
//
// THE CASE THIS EXISTS FOR IS THE THIRD ONE, and it is the only test in tools/
// that lies to the browser on purpose. On the reporter's Samsung S22 the game
// was laid out 941.6 CSS px tall on an 832 CSS px display: entering fullscreen
// left `100dvh` resolving to more height than the phone physically has, so the
// twin sticks and JUMP were below the bottom edge of the screen and no thumb
// could reach them. Nothing in a CSS-unit layout re-asks, so it stayed wrong
// until the phone was rotated.
//
// That state cannot be produced by resizing a window, because every viewport
// unit follows a resize. It CAN be produced with CDP: Emulation's
// setDeviceMetricsOverride takes the layout viewport and the screen as separate
// numbers, so `height` 110 px taller than `screenHeight` reproduces exactly the
// disagreement the S22 was in — the page believes in a viewport that is taller
// than the display. `stale` below is that run, and the assertion is that the
// controls stay inside the SCREEN.
//
// Usage: bun tools/test-viewport.mjs
import { launchBrowser, newContextPage, newPage, wait } from './browser.mjs';
import { BASE as HOST, NO_WARMUP } from './target.mjs';

// NO_WARMUP: every assertion is a getBoundingClientRect against --bs-vw/--bs-vh,
// which the sweep cannot move — see the note in tools/target.mjs.
const URL = `${HOST}/?fps=30&menu=0&${NO_WARMUP}`;
const PHONE = { width: 393, height: 851 };

const browser = await launchBrowser();
const results = {};

/**
 * Where every touch control sits relative to a box `h` tall and `w` wide, in CSS
 * px. `worstOverflow` is the furthest any control reaches past an edge of it —
 * the number the screenshot in issue #16 shows as ~110.
 */
const probeLayer = (page, w, h) => page.evaluate(({ w, h }) => {
  const sel = '.bs-stick,.bs-btn,.bs-skill';
  const items = [...document.querySelectorAll(sel)].map((el) => {
    const r = el.getBoundingClientRect();
    const cls = [...el.classList].filter((c) => c !== 'bs-btn' && c !== 'bs-skill'
      && c !== 'bs-stick').join('.') || el.textContent;
    return {
      name: cls,
      over: Math.max(0, r.right - w, r.bottom - h, -r.left, -r.top),
      bottom: +r.bottom.toFixed(1),
    };
  });
  const worst = items.reduce((a, b) => (b.over > a.over ? b : a), { over: 0, name: null });
  const layer = document.querySelector('.bs-touch')?.getBoundingClientRect();
  return {
    box: { w, h },
    layer: layer ? { w: +layer.width.toFixed(1), h: +layer.height.toFixed(1) } : null,
    hud: (() => {
      const r = document.querySelector('.bs-root')?.getBoundingClientRect();
      return r ? { w: +r.width.toFixed(1), h: +r.height.toFixed(1) } : null;
    })(),
    canvas: (() => {
      const c = document.querySelector('canvas');
      return c ? { w: c.clientWidth, h: c.clientHeight } : null;
    })(),
    controls: items.length,
    worstOverflow: +worst.over.toFixed(1),
    worstControl: worst.over > 0.5 ? worst.name : null,
    lowestControl: +items.reduce((a, b) => Math.max(a, b.bottom), 0).toFixed(1),
  };
}, { w, h });

const viewportDebug = (page) => page.evaluate(() => window.__dbgViewport?.() ?? null);

// ---------- desktop: the measurement must be the window, unchanged ----------
{
  const page = await newPage(browser, { width: 1280, height: 800 });
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await wait(2500);
  const v = await viewportDebug(page);
  results.desktop = {
    ...v,
    // A desktop has no browser chrome inside the page and no screen cap, so the
    // three numbers must agree exactly. Any drift here is the fix leaking into
    // the case it was never for.
    matchesWindow: v.w === v.innerW && v.h === v.innerH,
  };
  await page.close();
}

// ---------- phone: portrait, landscape, and back ----------
{
  const { ctx, page } = await newContextPage(browser, { ...PHONE, phone: true });
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await wait(4000);
  results.portrait = await probeLayer(page, PHONE.width, PHONE.height);
  results.portrait.viewport = await viewportDebug(page);

  // The rotation the reporter used to un-stick the layout. It must change
  // nothing here, because nothing was stuck.
  await page.setViewport({
    width: PHONE.height, height: PHONE.width,
    isMobile: true, hasTouch: true, isLandscape: true, deviceScaleFactor: 1,
  });
  await wait(1200);
  results.landscape = await probeLayer(page, PHONE.height, PHONE.width);

  await page.setViewport({
    width: PHONE.width, height: PHONE.height,
    isMobile: true, hasTouch: true, isLandscape: false, deviceScaleFactor: 1,
  });
  await wait(1200);
  results.portraitAgain = await probeLayer(page, PHONE.width, PHONE.height);
  await page.screenshot({ path: 'shots/_viewport-portrait.png' });
  await ctx.close();
}

// ---------- the S22: a viewport taller than the display ----------
{
  const { ctx, page } = await newContextPage(browser, { ...PHONE, phone: true });
  const client = await page.createCDPSession();
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await wait(4000);

  // 110 px is what was measured on the S22: 941.6 of believed viewport on an
  // 832 px screen. The page is told the layout viewport is the tall number and
  // the display is the short one — every viewport unit resolves to the tall
  // one, exactly as it did there.
  const OVERHANG = 110;
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: PHONE.width, height: PHONE.height + OVERHANG,
    screenWidth: PHONE.width, screenHeight: PHONE.height,
    deviceScaleFactor: 1, mobile: true,
    screenOrientation: { type: 'portraitPrimary', angle: 0 },
  });
  // Fullscreen is half the condition: the screen is only a bound on a page that
  // covers it. requestFullscreen needs a user activation, so it goes through a
  // real tap rather than an evaluate().
  await page.evaluate(() => {
    const b = document.createElement('button');
    b.id = 'fs-probe';
    Object.assign(b.style, {
      position: 'fixed', left: '0', top: '0', width: '60px', height: '40px', zIndex: '99999',
    });
    b.onclick = () => document.documentElement.requestFullscreen?.();
    document.body.appendChild(b);
  });
  await page.mouse.click(30, 20);
  await wait(1500);
  await page.evaluate(() => document.getElementById('fs-probe')?.remove());

  // What the stylesheet gets on its own. This is the number the S22 laid the
  // sticks out against, and with the override above every viewport unit —
  // `dvh`, `innerHeight`, the layout viewport — agrees on it, which is the
  // reason the display has to be asked separately at all.
  const dvh = await page.evaluate(() => {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:100dvh;pointer-events:none';
    document.body.appendChild(d);
    const h = d.getBoundingClientRect().height;
    d.remove();
    return h;
  });
  // BEFORE: the layer still sized from what the page believes, measured against
  // the display it is actually on. This is the screenshot in the issue.
  const before = await probeLayer(page, PHONE.width, PHONE.height);

  // The last thing CDP will not lie about for us: `Emulation`'s screenWidth /
  // screenHeight are not reflected in `window.screen` here (it kept answering
  // with the host's display), so the probe stubs the display itself. That is
  // the one synthetic number in this run, and it is the honest one — an S22
  // reports an 832 px display while believing in a 941.6 px viewport, and this
  // is the same disagreement at 851 against 961.
  await page.evaluate(({ w, h }) => {
    Object.defineProperty(window.screen, 'width', { value: w, configurable: true });
    Object.defineProperty(window.screen, 'height', { value: h, configurable: true });
    window.dispatchEvent(new Event('resize'));
  }, { w: PHONE.width, h: PHONE.height });
  await wait(400);

  const v = await viewportDebug(page);
  // AFTER, measured against the SCREEN rather than against the viewport the page
  // believes in.
  const after = await probeLayer(page, PHONE.width, PHONE.height);
  results.stale = {
    ...after,
    dvhResolvesTo: dvh,
    screenHeight: v?.screenH ?? null,
    measuredHeight: v?.h ?? null,
    fullscreen: v?.fullscreen ?? null,
    touchPrimary: v?.touchPrimary ?? null,
    overflowBefore: before.worstOverflow,
    // The whole point: the page believes in 110 px that the display does not
    // have, and no control is in them.
    fixed: dvh > PHONE.height && before.worstOverflow > 1 && after.worstOverflow <= 0.5,
  };
  // Through CDP, and not page.screenshot(): puppeteer re-applies its own cached
  // device metrics around a capture, which would undo the override this whole
  // section is about and produce a picture of a healthy layout.
  const shot = await client.send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: false,
    clip: { x: 0, y: 0, width: PHONE.width, height: PHONE.height, scale: 1 },
  });
  await Bun.write('shots/_viewport-stale.png', Buffer.from(shot.data, 'base64'));
  await ctx.close();
}

console.log(JSON.stringify(results, null, 2));
await browser.close();
