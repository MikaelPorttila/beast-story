// Verifies the F2 debug overlay toggles and that the browser never sees F2.
import { launchBrowser, newPage, wait, glRenderer } from './browser.mjs';

const target = process.argv[2] === 'lab' ? 'lab.html?beast=emberfox&fps=30' : '?play=1&fps=30';
const browser = await launchBrowser();
const page = await newPage(browser, { width: 900, height: 600 });
await page.goto(`http://localhost:5187/${target}`, { waitUntil: 'load' });
await page.waitForSelector('canvas');
console.log('renderer:', await glRenderer(page));
await wait(2500);

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

const before = await overlayShown();
await page.keyboard.press('F2');
await wait(2000); // let the readout accumulate a few frames before sampling
const afterOn = await overlayShown();
const text = await page.evaluate(() => {
  const el = [...document.body.children].find(
    (c) => c instanceof HTMLDivElement && (c.textContent || '').startsWith('FPS'),
  );
  return el ? (el.textContent || '').split('\n')[0] : null;
});
console.log('readout:', text);
await page.keyboard.press('F2');
await wait(2000);
const afterOff = await overlayShown();
const leaked = await page.evaluate(() => window.__f2Default);

console.log(JSON.stringify({ before, afterOn, afterOff, browserSawUnpreventedF2: leaked }, null, 2));
await browser.close();
