// Verifies the F2 debug overlay toggles and that the browser never sees F2.
import { launchBrowser, newPage, whenPlaying, glRenderer } from './browser.mjs';
import { BASE as HOST, NO_WARMUP } from './target.mjs';

// menu=0 on the game entry: the F2 overlay is a property of the running game,
// and a title screen in front of it would just be measuring the poster. The lab
// has no menu to suppress — nor a shader sweep, which is why only the game
// target carries NO_WARMUP: this file reads the overlay's own rows and asserts
// nothing about what a frame cost to draw.
const target = process.argv[2] === 'lab'
  ? 'lab.html?beast=emberfox&fps=30'
  : `?play=1&fps=30&menu=0&${NO_WARMUP}`;
const browser = await launchBrowser();
const page = await newPage(browser, { width: 900, height: 600 });
await page.goto(`${HOST}/${target}`, { waitUntil: 'load' });
await page.waitForSelector('canvas');
console.log('renderer:', await glRenderer(page));
// The lab has no boot handshake to wait on — it is up when its canvas is — so
// only the game target gets the state gate.
if (process.argv[2] !== 'lab') await whenPlaying(page);

// Track whether the browser got an unprevented F2.
await page.evaluate(() => {
  window.__f2Default = false;
  window.addEventListener('keydown', (e) => {
    if (e.code === 'F2' && !e.defaultPrevented) {
      window.__f2Default = true;
    }
  });
});

const overlayShown = async () => page.evaluate(() => {
  const el = [...document.body.children].find(
    (c) => c instanceof HTMLDivElement && (c.textContent || '').startsWith('FPS'),
  );
  return el ? el.style.display !== 'none' : null;
});

/**
 * Settle on the OVERLAY ITSELF, not on a guess at how many frames it needs.
 * The old `wait(2000)` after each press was standing in for two different
 * things: that the overlay had been built and had counted enough frames to
 * print a rate, and that it had gone again. Both are readable.
 */
const readoutReady = () => page.waitForFunction(() => {
  const el = [...document.body.children].find(
    (c) => c instanceof HTMLDivElement && (c.textContent || '').startsWith('FPS'),
  );
  return !!el && el.style.display !== 'none' && /FPS[^\d]*\d/.test(el.textContent || '');
}, { timeout: 15000 });

const readoutGone = () => page.waitForFunction(() => {
  const el = [...document.body.children].find(
    (c) => c instanceof HTMLDivElement && (c.textContent || '').startsWith('FPS'),
  );
  return !el || el.style.display === 'none';
}, { timeout: 15000 });

const before = await overlayShown();
await page.keyboard.press('F2');
await readoutReady();
const afterOn = await overlayShown();
const text = await page.evaluate(() => {
  const el = [...document.body.children].find(
    (c) => c instanceof HTMLDivElement && (c.textContent || '').startsWith('FPS'),
  );
  return el ? (el.textContent || '').split('\n')[0] : null;
});
console.log('readout:', text);
await page.keyboard.press('F2');
await readoutGone();
const afterOff = await overlayShown();
const leaked = await page.evaluate(() => window.__f2Default);

const fails = [];
// `null` means the div does not exist yet and `false` means it exists hidden.
// Before the first press it is the former — the overlay is built lazily on the
// first toggle — and both are "not up", so only `true` is a failure here.
if (before === true) fails.push('the overlay was already up before F2 was pressed');
if (afterOn !== true) fails.push('F2 did not raise the overlay');
if (!/FPS[^\d]*\d/.test(text ?? '')) fails.push(`the readout printed no rate: ${text}`);
if (afterOff !== false) fails.push('a second F2 did not put the overlay away');
if (leaked) fails.push('the browser saw an unprevented F2 — its own dev tools would open');

console.log(JSON.stringify({
  before, afterOn, afterOff, readout: text, browserSawUnpreventedF2: leaked,
  pass: fails.length === 0,
}, null, 2));
await browser.close();

// IT ASSERTS NOW. This file printed four booleans and exited 0 whatever they
// were, which is the silent-probe failure AGENTS.md names — and it is the one
// that hid a real regression once already: batched, every reading came back
// null because the overlay had not been built yet, and the run still passed
// (see the note on `f2` in tools/probe.mjs).
if (fails.length) {
  console.error(`\nFAIL:\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
console.log('\nOK');
