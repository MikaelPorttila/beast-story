// Screenshot tool for the visual critic loop.
// Usage: bun tools/screenshot.mjs <outfile.png> [urlQuery] [width] [height] [settleMs]
// Example: bun tools/screenshot.mjs shots/overview.png "photo=1&cam=10,14,18&look=0,9,0" 1920 1080 3500
import { launchBrowser, newPage, wait, logPageErrors } from './browser.mjs';

const [out = 'shot.png', query = '', w = '1920', h = '1080', settle = '3500'] = process.argv.slice(2);
// Agent captures run at 30 fps: a still frame gains nothing from more, and the
// cap stops an accelerated run from spinning the GPU at hundreds of fps while
// the world settles. Pass an explicit fps= (e.g. fps=0) for uncapped runs.
const q = /(^|&)fps=/.test(query) ? query : (query ? `${query}&fps=30` : 'fps=30');
const url = `http://localhost:5187/${q ? '?' + q : ''}`;

const browser = await launchBrowser();
const page = await newPage(browser, { width: +w, height: +h });
logPageErrors(page);
await page.goto(url, { waitUntil: 'load', timeout: 30000 });
await page.waitForSelector('canvas', { timeout: 15000 });
await wait(+settle);
await page.screenshot({ path: out });
await browser.close();
console.log('saved', out);
