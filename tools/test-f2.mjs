// Verifies the F2 debug overlay toggles and that the browser never sees F2.
import { chromium } from 'playwright';

const target = process.argv[2] === 'lab' ? 'lab.html?pal=emberfox&fps=30' : '?play=1&fps=30';
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
await page.goto(`http://localhost:5187/${target}`, { waitUntil: 'load' });
await page.waitForSelector('canvas');
await page.waitForTimeout(2500);

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
await page.waitForTimeout(4000); // software GL runs ~2 fps; allow several frames
const afterOn = await overlayShown();
const text = await page.evaluate(() => {
  const el = [...document.body.children].find(
    (c) => c instanceof HTMLDivElement && (c.textContent || '').startsWith('FPS'),
  );
  return el ? (el.textContent || '').split('\n')[0] : null;
});
console.log('readout:', text);
await page.keyboard.press('F2');
await page.waitForTimeout(2000);
const afterOff = await overlayShown();
const leaked = await page.evaluate(() => window.__f2Default);

console.log(JSON.stringify({ before, afterOn, afterOff, browserSawUnpreventedF2: leaked }, null, 2));
await browser.close();
