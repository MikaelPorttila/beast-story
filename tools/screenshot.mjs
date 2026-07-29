// Screenshot tool for the visual critic loop.
// Usage: node tools/screenshot.mjs <outfile.png> [urlQuery] [width] [height] [settleMs]
// Example: node tools/screenshot.mjs shots/overview.png "photo=1&cam=10,14,18&look=0,9,0" 1920 1080 3500
import { chromium } from 'playwright';

const [out = 'shot.png', query = '', w = '1920', h = '1080', settle = '3500'] = process.argv.slice(2);
// Agent captures run at 30 fps: software GL gains nothing from more frames.
// Pass an explicit fps= (e.g. fps=0) in the query for uncapped runs.
const q = /(^|&)fps=/.test(query) ? query : (query ? `${query}&fps=30` : 'fps=30');
const url = `http://localhost:5187/${q ? '?' + q : ''}`;

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 30000 });
await page.waitForSelector('canvas', { timeout: 15000 });
await page.waitForTimeout(+settle);
await page.screenshot({ path: out, timeout: 120000 });
await browser.close();
console.log('saved', out);
