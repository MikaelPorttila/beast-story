// Fast screenshot of the isolated lab stage (no world streaming).
// Usage: node tools/lab-shot.mjs <out.png> "<labQuery>" [width] [height]
// The lab's ?t= parameter freezes a deterministic frame, so shots are
// reproducible and need no settle time.
//   node tools/lab-shot.mjs shots/lab-fox.png "pal=emberfox&t=2&anim=cast"
//   node tools/lab-shot.mjs shots/lab-all.png "pals=all&t=1.5" 2000 700
import { chromium } from 'playwright';

const [out = 'lab.png', query = '', w = '1000', h = '800'] = process.argv.slice(2);
const hasFreeze = /(^|&)t=/.test(query);
// Live (non-frozen) lab runs are capped at 30 fps like the game captures.
// A frozen frame renders exactly once, so the cap is irrelevant there.
const q = hasFreeze || /(^|&)fps=/.test(query)
  ? query
  : (query ? `${query}&fps=30` : 'fps=30');
const url = `http://localhost:5187/lab.html${q ? '?' + q : ''}`;

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 30000 });
await page.waitForSelector('canvas', { timeout: 15000 });
// A frozen frame only needs the single render to land; live mode needs settling.
await page.waitForTimeout(hasFreeze ? 1200 : 3000);
await page.screenshot({ path: out, timeout: 120000 });
await browser.close();
console.log('saved', out);
