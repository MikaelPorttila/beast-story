// Verifies MOVING REFERENCE FRAMES (src/world/carriers.ts) and the one thing
// that implements them today, the flying town (src/world/sky-island.ts).
//
// Usage: bun tools/test-carrier.mjs      (dev server must be up)
//
// THE WHOLE FEATURE IS INVISIBLE TO A POSITION AND TO A SCREENSHOT, which is
// what this file is shaped around. "The hero is at (261, 86, -79)" says nothing
// — he is there whether he is riding the island or falling past it — and a still
// of a man on a deck is the same still either way. The question is whether he is
// in the same place ON THE DECK he was ten seconds ago while the deck has moved,
// so every assertion here is about `onDeck`: his position expressed in the
// island's own coordinates, reported by `__dbgCarriers()`.
//
// IT IS A PAIR AT ONE COLUMN, twice over, and neither half means anything alone:
//
//   RIDING     parked on the deck, the island must travel and `onDeck` must not.
//              On its own this passes in a world where the island never moved.
//   MOVING     the same run therefore requires the island to have covered real
//              ground — if it is standing still there is nothing to be carried by.
//   OFF        stepped past the rim, `riding` must go null and the hero must
//              fall. Without this, "onDeck never changes" would also pass for a
//              hero glued to a frame he can never leave, which is the opposite
//              defect and the one the issue explicitly asks against: jumping off
//              returns the actor to regular world space.
//   UNDER      parked on the ground BELOW the island, he must not attach and
//              must not be dragged. This is the assertion that would have caught
//              a containment test that forgot its `y` — the failure mode where
//              an island passing overhead teleports a walker into the sky.
//
// Section 5 is the people and section 6 is the compass, which are the two things
// the issue names besides the movement itself.
//
// Exits non-zero on failure.
import { launchBrowser, newPage, wait } from './browser.mjs';
import { BASE as HOST } from './target.mjs';

const URL = `${HOST}/?menu=0&fs=0&fps=30`;
const browser = await launchBrowser();
const page = await newPage(browser, { width: 1280, height: 800 });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));

await page.goto(URL, { waitUntil: 'load' });
await page.waitForSelector('canvas');
await wait(2500);

const results = {};
const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); };

const carriers = () => page.evaluate(() => window.__dbgCarriers());
const pos = () => page.evaluate(() => window.__dbgPlayerPos());
const tp = (x, z, y) => page.evaluate(([a, b, c]) => window.__dbgTp(a, b, c), [x, z, y]);

// ---------------------------------------------------------------------------
// 1. There is one, and it is going somewhere
// ---------------------------------------------------------------------------
const first = await carriers();
check(first.all.length === 1, `expected exactly one carrier, got ${first.all.length}`);
const island = first.all[0];
check(!!island, 'no carrier in the world at all');
if (!island) {
  console.log(JSON.stringify({ fails }, null, 2));
  await browser.close();
  process.exit(1);
}
results.carrier = {
  id: island.id, radius: island.radius, y: island.y, step: island.step,
};
// The keel is 27 units deep and the mountains it has to clear are 40-60 high,
// so anything under ~70 means the altitude rule is not running.
check(island.y >= 70, `island is at y ${island.y} — too low to clear the terrain`);

// ---------------------------------------------------------------------------
// 2. Parked on the deck: the world moves, the hero's place on the deck does not
// ---------------------------------------------------------------------------
{
  // Straight down onto the middle of the deck, from a little above it. The drop
  // is deliberate: it lands him through the same attach path a flyer takes,
  // rather than starting him already at rest on a surface.
  await tp(island.x, island.z, island.y + 12);
  await wait(1600);
  const a = await carriers();
  const before = a.all[0];
  const startPos = await pos();
  check(a.riding === island.id, `hero did not attach to the deck (riding: ${a.riding})`);
  check(before.deckTop !== null, 'no deck under the hero after landing on the island');

  await wait(9000);
  const b = await carriers();
  const after = b.all[0];
  const endPos = await pos();

  const travelled = Math.hypot(after.x - before.x, after.z - before.z);
  const drift = Math.hypot(after.onDeck.x - before.onDeck.x, after.onDeck.z - before.onDeck.z);
  results.riding = {
    islandTravelled: +travelled.toFixed(2),
    heroWorldMoved: +Math.hypot(endPos.x - startPos.x, endPos.z - startPos.z).toFixed(2),
    driftOnDeck: +drift.toFixed(3),
    onDeckBefore: before.onDeck,
    onDeckAfter: after.onDeck,
    stillRiding: b.riding,
  };

  // THE OTHER HALF OF THE PAIR: an island that did not move carries nothing, and
  // every number below it would be trivially satisfied.
  check(travelled > 8,
    `the island only travelled ${travelled.toFixed(2)} units in 9 s — nothing to be carried by`);
  // ...and the feature. A standing hero drifts by the settling of his own
  // physics and nothing else; a whole unit over nine seconds would be the frame
  // sliding out from under him.
  check(drift < 1.0,
    `hero drifted ${drift.toFixed(2)} units across the deck while standing still`);
  check(b.riding === island.id, 'hero fell off the island while standing still on it');
}

// ---------------------------------------------------------------------------
// 3. Off the rim: back to world space, and falling
// ---------------------------------------------------------------------------
{
  const a = (await carriers()).all[0];
  // Just past the rim, at deck height. `radius` is the ride volume's own bound,
  // so a body a couple of units outside it is outside by the frame's own rule
  // rather than by a number this file invented.
  await tp(a.x + a.radius + 3, a.z, a.y + 4);
  await wait(1200);
  const b = await carriers();
  const p1 = await pos();
  await wait(900);
  const p2 = await pos();
  results.steppedOff = {
    riding: b.riding,
    y1: +p1.y.toFixed(2), y2: +p2.y.toFixed(2), fell: +(p1.y - p2.y).toFixed(2),
  };
  check(b.riding === null, `hero is still riding ${b.riding} from outside the island`);
  check(p2.y < p1.y - 3,
    `hero did not fall after leaving the island (${p1.y.toFixed(1)} -> ${p2.y.toFixed(1)})`);
}

// ---------------------------------------------------------------------------
// 4. Underneath it: not attached, not dragged
// ---------------------------------------------------------------------------
{
  const a = (await carriers()).all[0];
  // On the ground directly below the middle of the island — `__dbgTp` with no
  // y resolves the height field, which is exactly the case that must be immune.
  await tp(a.x, a.z);
  await wait(600);
  const b = await carriers();
  const p1 = await pos();
  await wait(4000);
  const p2 = await pos();
  const moved = Math.hypot(p2.x - p1.x, p2.z - p1.z);
  const c = (await carriers()).all[0];
  results.underneath = {
    riding: b.riding,
    heroMoved: +moved.toFixed(3),
    islandMoved: +Math.hypot(c.x - a.x, c.z - a.z).toFixed(2),
    heroY: +p2.y.toFixed(2),
    deckY: c.y,
  };
  check(b.riding === null,
    'hero standing on the GROUND under the island was attached to it — '
    + 'the containment test has lost its vertical bound');
  // MEASURED AGAINST THE ISLAND'S OWN TRAVEL, not against zero. A hero who is
  // being carried moves EXACTLY as far as the frame does, so the discriminator
  // is the ratio; a fixed small bound fails on things that have nothing to do
  // with carriers — measured 1.56 units in 4 s standing in open country, which
  // is a wild spawn's knockback and settling onto a slope, against an island
  // that covered 10.88 in the same window.
  check(moved < results.underneath.islandMoved * 0.35,
    `hero on the ground moved ${moved.toFixed(2)} units while the island overhead `
    + `moved ${results.underneath.islandMoved} — that is being dragged, not standing`);
}

// ---------------------------------------------------------------------------
// 5. The residents travel with it
// ---------------------------------------------------------------------------
{
  const a = (await carriers()).all[0];
  const npcs = await page.evaluate(() => window.__dbgNpcs());
  const crew = npcs.all.filter((n) => n.id.startsWith('sky-'));
  const offsets = crew.map((n) => +Math.hypot(n.x - a.x, n.z - a.z).toFixed(2));
  await wait(5000);
  const b = (await carriers()).all[0];
  const npcs2 = await page.evaluate(() => window.__dbgNpcs());
  const crew2 = npcs2.all.filter((n) => n.id.startsWith('sky-'));
  const offsets2 = crew2.map((n) => +Math.hypot(n.x - b.x, n.z - b.z).toFixed(2));
  results.residents = {
    count: crew.length,
    islandMoved: +Math.hypot(b.x - a.x, b.z - a.z).toFixed(2),
    offsetsBefore: offsets,
    offsetsAfter: offsets2,
    heights: crew2.map((n) => +n.y.toFixed(2)),
  };
  check(crew.length === 3, `expected 3 skyfolk, found ${crew.length}`);
  // They are placed in the island's frame and republished in world coordinates
  // every slice, so their distance FROM THE ISLAND is the invariant — it is a
  // placement, and it must not change while the world position does.
  for (let i = 0; i < offsets.length; i++) {
    check(Math.abs(offsets2[i] - offsets[i]) < 1.0,
      `${crew[i].id} moved ${(offsets2[i] - offsets[i]).toFixed(2)} relative to the island`);
    check(offsets2[i] < a.radius,
      `${crew[i].id} is ${offsets2[i]} from the island centre, outside its ${a.radius} rim`);
  }
  for (const n of crew2) {
    check(n.y > b.y - 5, `${n.id} is at y ${n.y}, below the deck at ${b.y}`);
  }
}

// ---------------------------------------------------------------------------
// 6. The compass knows where it is now
// ---------------------------------------------------------------------------
{
  // Somewhere with a clear view, and NOT under the island — the bearing to a
  // marker you are standing on top of swings wildly and says nothing.
  const a = (await carriers()).all[0];
  await tp(a.x - 160, a.z - 160);
  await wait(700);
  const c1 = await page.evaluate(() => window.__dbgCompass());
  const m1 = c1.markers.find((m) => m.id === 'town:skyhaven');
  await wait(6000);
  const c2 = await page.evaluate(() => window.__dbgCompass());
  const m2 = c2.markers.find((m) => m.id === 'town:skyhaven');
  const b = (await carriers()).all[0];
  results.compass = {
    marker: m1 ? m1.id : null,
    relBefore: m1 ? m1.rel : null,
    relAfter: m2 ? m2.rel : null,
    islandMoved: +Math.hypot(b.x - a.x, b.z - a.z).toFixed(2),
  };
  check(!!m1, 'no compass chip for the flying town');
  // The hero has not moved and the camera has not turned, so any change in the
  // chip's bearing is the TOWN having moved — which is the whole assertion. A
  // chip built from a placement-time snapshot reads exactly 0 here.
  if (m1 && m2) {
    check(Math.abs(m2.rel - m1.rel) > 0.5,
      `the flying town's compass chip did not move (${m1.rel} -> ${m2.rel}) `
      + `while the town travelled ${results.compass.islandMoved} units`);
  }
}

console.log(JSON.stringify({ ...results, fails }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
