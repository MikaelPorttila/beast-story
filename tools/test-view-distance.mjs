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
await page.waitForFunction(() => window.__dbgZone?.().streaming === false, { timeout: 60_000 });

const before = await page.evaluate(() => window.__dbgDistantTerrain?.());
const fails = [];
const check = (ok, message) => { if (!ok) fails.push(message); };
check(before !== null && before !== undefined, 'overworld created no distant terrain');
if (before) {
  check(before.terrainVertices > 1_000 && before.terrainVertices < 20_000,
    `far terrain is not a coarse consolidated mesh: ${before.terrainVertices} vertices`);
  check(before.waterVertices === before.terrainVertices,
    `terrain/water clipmaps disagree: ${JSON.stringify(before)}`);
  check(before.wetWaterVertices > 0,
    'far water sampled no wet vertices from the terrain field');
  check(before.step >= 8,
    `far terrain kept near-detail resolution (${before.step}m samples)`);
  check(before.outerRadius > 600,
    `far terrain can end inside the camera plane (${before.outerRadius}m)`);
  check(before.outerRadius >= before.viewDistance + 64,
    `far terrain has no snap-cell reserve: ${JSON.stringify(before)}`);
  check(before.innerRadius < 160,
    `far terrain does not overlap the streamed rim (${before.innerRadius}m)`);
  check(before.ready === true && before.building === false,
    `play began with an incomplete far underlay: ${JSON.stringify(before)}`);
  check(before.waterFadeEnd === before.innerRadius + 32
    && before.waterFadeStart === before.waterFadeEnd - 48,
  `water handoff is not aligned to the detailed ring: ${JSON.stringify(before)}`);

  // The player setting changes the rendered budgets themselves. High keeps
  // more 1 m chunks and swaps the far field to a denser, longer grid; Low does
  // the inverse. This is deliberately not an assertion on the stored value.
  await page.evaluate(() => window.__dbgGfx?.('terrainDistance', 900));
  await page.waitForFunction(() => window.__dbgDistantTerrain?.().building === false,
    { timeout: 60_000 });
  const high = await page.evaluate(() => window.__dbgDistantTerrain?.());
  check(high.viewDistance === 900 && high.outerRadius > 900,
    `High did not extend the rendered horizon: ${JSON.stringify(high)}`);
  check(high.innerRadius === before.innerRadius,
    `High queued extra cube-detail terrain: ${before.innerRadius} -> ${high.innerRadius}`);
  check(high.step < before.step && high.terrainVertices > before.terrainVertices * 3,
    `High did not increase far LOD density: ${JSON.stringify({ before, high })}`);

  await page.evaluate(() => window.__dbgGfx?.('terrainDistance', 480));
  await page.waitForFunction(() => window.__dbgDistantTerrain?.().building === false,
    { timeout: 60_000 });
  const low = await page.evaluate(() => window.__dbgDistantTerrain?.());
  check(low.viewDistance === 480 && low.outerRadius > 480,
    `Low can expose the far mesh edge: ${JSON.stringify(low)}`);
  check(low.step > before.step && low.terrainVertices < before.terrainVertices,
    `Low did not reduce far LOD work: ${JSON.stringify({ before, low })}`);
  // Restore the default and clear the localStorage override before movement.
  await page.evaluate(() => window.__dbgGfx?.('terrainDistance', 600));
  await page.waitForFunction(() => window.__dbgDistantTerrain?.().building === false,
    { timeout: 60_000 });

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

  // A stored High choice must be part of world construction, not a second
  // synchronous rebuild after the loading gate has already released play.
  await page.evaluate(() => localStorage.setItem('game.settings.graphics.terrainDistance', '900'));
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__dbgBoot?.().playing === true, { timeout: 60_000 });
  await page.waitForFunction(() => window.__dbgZone?.().streaming === false, { timeout: 60_000 });
  const bootHigh = await page.evaluate(() => ({
    distant: window.__dbgDistantTerrain?.(),
    zone: window.__dbgZone?.(),
  }));
  check(bootHigh.distant?.viewDistance === 900,
    `stored High was applied after construction: ${JSON.stringify(bootHigh)}`);
  check(bootHigh.distant?.ready === true && bootHigh.distant?.building === false,
    `High loading released an incomplete HLOD: ${JSON.stringify(bootHigh)}`);
  check(bootHigh.zone?.streaming === false,
    `High loading released while terrain was streaming: ${JSON.stringify(bootHigh.zone)}`);
  await page.evaluate(() => localStorage.removeItem('game.settings.graphics.terrainDistance'));
  console.log(JSON.stringify({ before, high, low, after, bootHigh, pageErrors: errors }, null, 2));
}

check(errors.length === 0, `page errors: ${errors.join('; ')}`);
if (fails.length) {
  console.error(`\nFAIL (${fails.length})`);
  for (const fail of fails) console.error(`  - ${fail}`);
}
await browser.close();
process.exit(fails.length ? 1 : 0);
