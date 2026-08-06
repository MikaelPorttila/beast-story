// Guards the incremental chunk builder. A long teleport deliberately replaces
// a complete view disk; the assertion compares the worst world slice with the
// run's median so it scales with the host CPU instead of baking in one machine's
// millisecond figure.
//
// Usage: bun tools/test-streaming-stutter.mjs   (dev server must be up)
import { launchBrowser, newPage } from './browser.mjs';
import { BASE as HOST } from './target.mjs';

const browser = await launchBrowser();
const page = await newPage(browser, { width: 1280, height: 720 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`${HOST}/?menu=0&fs=0&vol=0&perf=1&fps=0`, { waitUntil: 'load' });
await page.waitForSelector('canvas');
await page.waitForFunction(() => window.__dbgBoot?.().playing === true, { timeout: 60_000 });
await page.waitForFunction(() => window.__dbgZone?.().streaming === false, { timeout: 60_000 });

const first = await page.evaluate(() => window.__dbgPerf().rows.length);
await page.evaluate(() => {
  const p = window.__dbgZone().player;
  window.__dbgTp(p.x + 320, p.z);
});
await page.waitForFunction(() => window.__dbgZone?.().streaming === true, { timeout: 10_000 });
await page.waitForFunction(() => window.__dbgZone?.().streaming === false, { timeout: 60_000 });

const dump = await page.evaluate(() => window.__dbgPerf());
const worldAt = dump.sections.indexOf('world');
const wallAt = dump.sections.indexOf('wall');
const chunkAt = dump.sections.length + dump.counters.indexOf('chunks');
const rows = dump.rows.slice(first);
const worlds = rows.map((r) => r[worldAt]).sort((a, b) => a - b);
const walls = rows.map((r) => r[wallAt]).sort((a, b) => b - a);
// At an uncapped render rate some rAF callbacks do not contain a fixed world
// tick and correctly record zero. Compare build slices with ordinary world
// ticks, not with those render-only frames.
const worldTicks = worlds.filter((ms) => ms > 0.05);
const medianWorld = worldTicks[Math.floor(worldTicks.length / 2)];
const maxWorld = worlds.at(-1);
const completedChunks = rows.reduce((n, r) => n + r[chunkAt], 0);
const onePctWall = walls[Math.max(0, Math.ceil(walls.length * 0.01) - 1)];

const fails = [];
const check = (ok, message) => { if (!ok) fails.push(message); };
check(errors.length === 0, `page errors: ${errors.join('; ')}`);
check(completedChunks >= 40, `teleport only completed ${completedChunks} fresh chunks`);
check(worldTicks.length > completedChunks * 3,
  `chunk work was not distributed across ticks: ${worldTicks.length} ticks / ${completedChunks} chunks`);
// The pre-fix prop pass was 6x the ordinary world slice (19.6 vs ~3 ms). The
// stepper measures ~2.2x (6.8 vs ~3 ms); 3.5x leaves room for CPU variance and
// still fails if an entire vegetation chunk becomes indivisible again.
check(maxWorld <= medianWorld * 3.5 + 0.5,
  `streaming world spike ${maxWorld} ms vs ${medianWorld} ms median`);

console.log(JSON.stringify({
  frames: rows.length,
  completedChunks,
  worldTicks: worldTicks.length,
  medianWorld,
  maxWorld,
  maxWall: walls[0],
  onePctWall,
  pageErrors: errors,
}, null, 2));
if (fails.length) {
  console.error(`\nFAIL (${fails.length})`);
  for (const fail of fails) console.error(`  - ${fail}`);
}
await browser.close();
process.exit(fails.length ? 1 : 0);
