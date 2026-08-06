// Guards the distant landscape added for issue #96. The assertion is on the
// rendered mesh census and its movement, not on a setting or URL flag.
//
// Usage: bun tools/test-view-distance.mjs   (dev server must be up)
// Exits non-zero.
import { launchBrowser, newPage, wait } from './browser.mjs';
import { BASE as HOST } from './target.mjs';

const browser = await launchBrowser();
const page = await newPage(browser, { width: 1280, height: 800 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${HOST}/?menu=0&fs=0&vol=0`, { waitUntil: 'load' });
await page.waitForSelector('canvas');
await page.waitForFunction(() => window.__dbgBoot?.().playing === true, { timeout: 60_000 });

const before = await page.evaluate(() => window.__dbgDistantTerrain?.());
const fails = [];
const check = (ok, message) => { if (!ok) fails.push(message); };
check(before !== null && before !== undefined, 'overworld created no distant terrain');
if (before) {
  check(before.terrainVertices > 1_000 && before.terrainVertices < 10_000,
    `far terrain is not a coarse consolidated mesh: ${before.terrainVertices} vertices`);
  check(before.waterVertices === before.terrainVertices,
    `terrain/water clipmaps disagree: ${JSON.stringify(before)}`);
  check(before.wetWaterVertices > 0,
    'far water sampled no wet vertices from the terrain field');
  check(before.step >= 8,
    `far terrain kept near-detail resolution (${before.step}m samples)`);
  check(before.outerRadius > 600,
    `far terrain can end inside the camera plane (${before.outerRadius}m)`);
  check(before.innerRadius < 160,
    `far terrain does not overlap the streamed rim (${before.innerRadius}m)`);

  // Move three snap cells. A fixed wait is not the assertion: poll the mesh's
  // own anchor until a rendered frame has advanced the camera-following grid.
  await page.evaluate(([x, z]) => window.__dbgTp(x + 192, z), before.anchor);
  let after = before;
  for (let i = 0; i < 40; i++) {
    await wait(100);
    after = await page.evaluate(() => window.__dbgDistantTerrain?.());
    if (after?.anchor?.[0] !== before.anchor[0]) break;
  }
  check(after.anchor[0] - before.anchor[0] >= 128,
    `clipmap did not follow the player: ${before.anchor} -> ${after.anchor}`);
  check(after.terrainVertices === before.terrainVertices,
    'moving the clipmap changed its fixed geometry budget');
  console.log(JSON.stringify({ before, after, pageErrors: errors }, null, 2));
}

check(errors.length === 0, `page errors: ${errors.join('; ')}`);
if (fails.length) {
  console.error(`\nFAIL (${fails.length})`);
  for (const fail of fails) console.error(`  - ${fail}`);
}
await browser.close();
process.exit(fails.length ? 1 : 0);
