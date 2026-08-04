// The flying island, from the six angles the reference art uses.
//
// Usage: bun tools/shot-sky.mjs [outDir]     (dev server must be up)
//
// ONE BROWSER, SIX FRAMES, and that is the whole reason this exists rather than
// six calls to `screenshot.mjs`. The island is the slowest thing in the world to
// get a camera to — it is somewhere different every run, so every shot needs the
// live position read out of the page first, and a cold boot is ~4 s. Six of
// those is a minute a round; this is one boot and about fifteen seconds, which
// is the difference between iterating on a silhouette and giving up on it.
//
// THE ANGLES ARE THE REFERENCE'S, deliberately and in its order, so a critic can
// put the two sheets side by side without matching shots up first:
//
//   1 front3q     the entrance side, tower and key buildings
//   2 side        the profile: cliff layers, vegetation, the fall
//   3 rear3q      the back of the settlement
//   4 topdown     the town plan — paths, buildings, trees
//   5 underside   the low angle the rocky keel lives or dies on
//   6 distant     the establishing shot, island small in open sky
//
// `photo=1` freezes the world's clocks, and the island is pinned by the same
// flag (see `flags.photo` in world/sky-island.ts), so two runs of this against
// the same build produce the same six pictures.
import { launchBrowser, newPage, wait } from './browser.mjs';
import { BASE as HOST } from './target.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'shots/sky';
mkdirSync(OUT, { recursive: true });

const W = 1280;
const H = 900;

const browser = await launchBrowser();
const page = await newPage(browser, { width: W, height: H });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));

// A first boot, only to find out where the island and the spawn are. `?cam=` and
// `?look=` are OFFSETS FROM `spawnPoint` (see AGENTS.md), so every framing below
// has to be expressed relative to it — feeding them world coordinates renders a
// plausible picture of the wrong place rather than an error.
await page.goto(`${HOST}/?menu=0&fs=0&fps=30`, { waitUntil: 'load' });
await page.waitForSelector('canvas');
await wait(3000);
const info = await page.evaluate(() => ({
  sky: window.__dbgCarriers().all[0],
  spawn: window.__dbgTowns().spawn,
}));
if (!info.sky) {
  console.error('no carrier in the world — nothing to photograph');
  await browser.close();
  process.exit(1);
}
const { sky, spawn } = info;
console.log(`island at ${sky.x.toFixed(1)}, ${sky.y.toFixed(1)}, ${sky.z.toFixed(1)}  r=${sky.radius}`);

/** Island centre as an offset from spawn, which is what `look=` wants. */
const cx = sky.x - spawn.x;
const cy = sky.y - spawn.y;
const cz = sky.z - spawn.z;
const R = sky.radius;

/** A camera at bearing `a`, `d` radii out, `h` units above the deck. */
const orbit = (a, d, h, lookDrop = 0) => ({
  cam: [cx + Math.sin(a) * R * d, cy + h, cz + Math.cos(a) * R * d],
  look: [cx, cy + lookDrop, cz],
});

// THE DISTANCES ARE IN RADII AND THE RADIUS TRIPLED, which is why they are
// tighter than they look. The scene's aerial perspective fades a surface into
// the sky over 150..420 units (core/engine.ts), so at the 2.2 radii these were
// framed at when the island was 107 across, a 187-unit island sits at 225 units
// and comes back half haze. Framing is a compromise between fitting the whole
// silhouette in and staying in front of the fog; 1.5 radii is about the limit.
const SHOTS = [
  { name: '1-front3q', ...orbit(0.6, 1.7, 34, 6) },
  { name: '2-side', ...orbit(1.9, 1.6, 10, 2) },
  { name: '3-rear3q', ...orbit(3.9, 1.7, 34, 6) },
  { name: '4-topdown', ...orbit(0.9, 1.05, 128, 2) },
  { name: '5-underside', ...orbit(2.6, 1.35, -46, -22) },
  { name: '6-distant', ...orbit(5.2, 2.6, 42, 0) },
];

const n3 = (v) => v.map((k) => k.toFixed(1)).join(',');

for (const s of SHOTS) {
  const url = `${HOST}/?photo=1&hud=0&fs=0&fps=30&cam=${n3(s.cam)}&look=${n3(s.look)}`;
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  // The island is built at world creation and never streams, so the only thing
  // to wait for is the terrain under it and the shader warm-up.
  await wait(3600);
  const buf = await page.screenshot({ type: 'png' });
  const path = `${OUT}/${s.name}.png`;
  writeFileSync(path, buf);
  console.log(`saved ${path}`);
}

await browser.close();
