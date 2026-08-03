// Ask the running game one question, from the shell.
//
//   bun tools/q.mjs "__dbgTowns().spawn"
//   bun tools/q.mjs "__dbgPlayerPos()" "__dbgCamYaw()" --wait 3000
//   bun tools/q.mjs "__dbgGfx()" --url "?menu=0&fps=30&ao=0"
//   bun tools/q.mjs "__dbgRigs?.().length" --lab "beast=emberfox&t=2"
//
// Every debug hook in main.ts exists so a tool can read it, and until now
// reading ONE of them meant writing a throwaway probe: boot a browser, wait for
// the canvas, evaluate, print, delete the file. That is a minute of work and a
// file that sometimes did not get deleted. This is the same six lines,
// parameterised, printing one JSON value per expression and nothing else.
//
// It is a READER. Expressions run in page context and anything they return has
// to survive structuredClone — a THREE.Vector3 comes back as {x,y,z}, a mesh
// comes back as an error rather than a wall of geometry. Reach for a real probe
// when you need to drive input over time; reach for this when you need a
// number.
import { launchBrowser, newPage, wait } from './browser.mjs';
import { BASE } from './target.mjs';

const argv = process.argv.slice(2);
const exprs = [];
const opt = { wait: 2500, url: '?menu=0&fps=30', width: 900, height: 600, lab: null, raw: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--wait') opt.wait = Number(argv[++i]);
  else if (a === '--url') opt.url = argv[++i];
  else if (a === '--lab') opt.lab = argv[++i] ?? '';
  else if (a === '--size') { const [w, h] = argv[++i].split('x').map(Number); opt.width = w; opt.height = h; }
  else if (a === '--raw') opt.raw = true; // one bare value, unquoted — for shell capture
  else if (a.startsWith('--')) { console.error(`unknown flag ${a}`); process.exit(2); }
  else exprs.push(a);
}
if (!exprs.length) {
  console.error('usage: bun tools/q.mjs "<expression>" [more...] [--wait ms] [--url "?..."] [--lab "beast=..."] [--size 900x600] [--raw]');
  process.exit(2);
}

const target = opt.lab === null ? opt.url : `lab.html?${opt.lab}`;
const browser = await launchBrowser();
const page = await newPage(browser, { width: opt.width, height: opt.height });

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

let out;
try {
  await page.goto(`${BASE}/${target.replace(/^\/?/, '')}`, { waitUntil: 'load' });
  await page.waitForSelector('canvas', { timeout: 30000 });
  await wait(opt.wait);
  // Evaluated one at a time and in order: a later expression is allowed to
  // depend on an earlier one having run (`/mount galebird` then a position).
  out = [];
  for (const e of exprs) {
    // The IIFE lets an expression be a statement sequence too.
    out.push(await page.evaluate(`(() => { try { return (${e}); } catch (err) { return { __error: String(err) } } })()`));
  }
} catch (err) {
  console.error(String(err.message ?? err));
  await browser.close();
  process.exit(1);
}
await browser.close();

const value = out.length === 1 ? out[0] : out;
if (opt.raw && (value === null || typeof value !== 'object')) console.log(String(value));
else console.log(JSON.stringify(value));
if (errors.length) console.error(`page errors: ${errors.length}\n  ${errors.slice(0, 3).join('\n  ')}`);
process.exit(out.some((v) => v && typeof v === 'object' && '__error' in v) ? 1 : 0);
