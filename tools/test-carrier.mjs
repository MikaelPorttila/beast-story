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
// Sections 7 and 8 are issue #80 and they are about the frame being a BODY
// rather than a surface:
//
//   KEEL       a flyer climbing at the underside is stopped by it. The deck was
//              the only face the carrier had, so you flew in through the rock
//              and sat inside the mountain.
//   SHOVED     a body the island has moved onto is pushed OUT along the flank
//              and never lifted over the top. Resolving it upward is a teleport
//              onto the island, which is the first fix's own bug.
//   WOOD       the trees stamped onto the deck block. They carry a `trunk` and
//              not a `solid`, and the registry that makes a trunk solid in the
//              overworld is keyed by streamed chunk — which a deck has none of.
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
  // OPEN GRASS, NOT THE MIDDLE. The middle of the deck is where the tower
  // stands, and `localTop` there is the tower's roof twenty units up — a hero
  // dropped into that column is INSIDE the building, below its top, and
  // therefore outside the ride volume, so he never attaches and falls through
  // the island. It reads as a carrier bug and is a probe that aimed at a
  // chimney. Two thirds of the way out is the ring the houses stand on, so this
  // is a garden between two of them.
  //
  // The drop is deliberate: it lands him through the same attach path a flyer
  // takes, rather than starting him already at rest on a surface.
  await tp(island.x + island.radius * 0.62, island.z, island.y + 8);
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
  // AGAINST THE CRUISE, not a number picked once. The island does 1.0 units/s
  // and takes a few seconds to accelerate onto a heading, so nine seconds is
  // seven or eight units of real travel; the assertion only has to be big
  // enough that a STOPPED island fails it, which is what makes the drift
  // measurement below mean anything.
  check(travelled > 4,
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

// ---------------------------------------------------------------------------
// 7. It is a SLAB: you cannot fly in through the keel
// ---------------------------------------------------------------------------
// Issue #80, first half — a photograph of a mount sitting inside the rock. The
// deck was the only face the frame had, and `CarrierRide.support` is gated on
// being attached, so a flyer climbing at the underside was flying at nothing.
//
// THE ASSERTION IS THE SLAB, not an altitude: at every sample inside the
// island's footprint the animal is on ONE SIDE of the pair (under the keel or
// on the deck) and never between them. That holds whatever the island's own
// altitude is doing, which a fixed number would not.
{
  await page.evaluate(() => window.__dbgRide('off'));
  const a = (await carriers()).all[0];
  // On the ground under the middle of it — the deepest part of the keel and the
  // straightest line at the island there is.
  await tp(a.x, a.z);
  await wait(600);
  const said = await page.evaluate(() => window.__dbgRide('galebird'));
  const m0 = await page.evaluate(() => window.__dbgMount());
  check(m0.mounted && m0.locomotion === 'flying',
    `could not get a flyer under the island: ${said}`);

  // STARTED IN THE AIR UNDER THE KEEL, and the altitude is read off the frame
  // rather than picked: the deck cruises around 190 and the keel is most of a
  // hundred units of rock below it, so a galebird climbing at 7 units/s spends
  // the whole run climbing and never reaches the thing being tested. `keel` is a
  // column query and does not care where the asker is, so it can be read from
  // the ground. 25 units is three seconds of climb.
  const start = (await carriers()).all[0];
  check(start.keel !== null, 'no keel under the middle of the island');
  await tp(a.x, a.z, start.keel - 25);
  await wait(600);

  const samples = [];
  await page.keyboard.down('Space');
  for (let i = 0; i < 24; i++) {
    await wait(500);
    const c = await carriers();
    const mm = await page.evaluate(() => window.__dbgMount());
    samples.push({
      y: mm.bodyY,
      keel: c.all[0].keel,
      surface: c.all[0].surface,
      deck: c.all[0].deckTop,
      riding: c.riding,
    });
  }
  await page.keyboard.up('Space');
  await wait(400);

  const under = samples.filter((s) => s.keel !== null);
  // Between the KEEL and the TURF — `surface`, not `deckTop`, which is the top
  // of whatever is standing in the column. The animal is inside the rock, which
  // is the bug.
  const inside = under.filter((s) => s.y > s.keel + 0.5 && s.y < s.surface - 0.5);
  const climbed = samples[samples.length - 1].y - samples[0].y;
  const last = samples[samples.length - 1];
  results.keel = {
    samples: samples.length,
    underTheIsland: under.length,
    insideTheRock: inside.length,
    climbed: +climbed.toFixed(2),
    endY: last.y, endKeel: last.keel, endSurface: last.surface,
    worst: inside[0] ?? null,
  };
  // THE OTHER HALF OF THE PAIR, twice: the hold has to have been a real climb,
  // and it has to have been made where the island actually is. Without either,
  // "he never got inside the rock" is what a probe that pressed nothing reports.
  check(climbed > 15,
    `the flyer only climbed ${climbed.toFixed(1)} units in 12 s — nothing was tested`);
  check(under.length > 12,
    `only ${under.length} of ${samples.length} samples were under the island at all`);
  check(inside.length === 0,
    `the flyer was inside the rock on ${inside.length} samples, first at y `
    + `${inside[0]?.y} between keel ${inside[0]?.keel} and turf ${inside[0]?.surface}`);
  // And he is held AGAINST the keel rather than stopped somewhere below it by
  // the ordinary flight ceiling, which would make the run above prove nothing
  // about the island. FLY_CLEARANCE is 1.3.
  if (last.keel !== null) {
    check(last.keel - last.y < 6,
      `the climb stopped ${(last.keel - last.y).toFixed(1)} units under the keel — `
      + 'something other than the island is the ceiling here');
  }
  await page.evaluate(() => window.__dbgRide('off'));
}

// ---------------------------------------------------------------------------
// 7b. Caught by the flank: pushed OUT, never lifted over
// ---------------------------------------------------------------------------
// The first fix for section 7 resolved a body found inside the mass upward, onto
// the deck. That is a teleport onto the island — the report's own complaint read
// backwards — and it is what a body being run down by a moving mountain must not
// get. The mass is refused horizontally and resolved SIDEWAYS: the island
// carries you along its flank rather than swallowing you or handing you the
// summit.
//
// Staged with a teleport because the honest version — hovering in the island's
// path until it arrives — is a wait on a wandering frame, and the physics cannot
// tell the difference: both are "this slice, a body is in the rock".
{
  await page.evaluate(() => window.__dbgRide('off'));
  const a = (await carriers()).all[0];
  // MOUNT FIRST AND TELEPORT SECOND. Mounting snaps the rider onto the animal,
  // which is standing on the ground wherever it was following him from, so a
  // teleport before it is a teleport of somebody who is about to be moved.
  // `__dbgTp` carries the pair (see its note in main.ts), which is why the
  // second one holds.
  await tp(a.x, a.z);
  await wait(500);
  const said = await page.evaluate(() => window.__dbgRide('galebird'));
  check((await page.evaluate(() => window.__dbgMount())).mounted, `no flyer: ${said}`);
  // Halfway out along the radius and well under the turf: inside the cliff, on
  // the keel's shoulder rather than at its thin rim.
  const staged = a.radius * 0.5;
  await tp(a.x + staged, a.z, a.y - 20);
  await wait(200);
  const c0 = (await carriers()).all[0];

  await wait(2000);
  const s1 = await carriers();
  const c1 = s1.all[0];
  const p1 = await pos();
  const m1 = await page.evaluate(() => window.__dbgMount());
  const d1 = Math.hypot(p1.x - c1.x, p1.z - c1.z);
  const inRock = c1.keel !== null && m1.bodyY > c1.keel && m1.bodyY < c1.surface;
  results.shoved = {
    startedInRock: c0.keel !== null && a.y - 20 > c0.keel,
    fromCentre: +staged.toFixed(2), toCentre: +d1.toFixed(2), radius: c1.radius,
    y: m1.bodyY, surface: c1.surface, keel: c1.keel, stillInRock: inRock,
    riding: s1.riding,
  };
  check(results.shoved.startedInRock,
    `the flyer was not staged inside the rock (y ${a.y - 20}, keel ${c0.keel})`);
  check(!inRock, `still inside the rock after 2 s at y ${m1.bodyY} `
    + `(turf ${c1.surface}, keel ${c1.keel})`);
  // THE TWO HALVES OF "PUSHED, NOT LIFTED". Outward, and not up: a body that
  // ended over the turf got the teleport this section exists to forbid, and one
  // that ended no further out than it started was not pushed at all.
  // AGAINST WHERE HE WAS PUT, not against a reading taken after the fact: the
  // march is 120 units a second, so by the time a probe has asked twice it is
  // measuring the tail of the push rather than the push.
  check(d1 > staged + 5,
    `the flyer was not pushed outward: staged at ${staged.toFixed(1)}, ended at `
    + `${d1.toFixed(1)} units from the centre`);
  check(!(m1.bodyY > c1.surface && c1.surface !== null),
    `the flyer was lifted onto the deck (y ${m1.bodyY} over turf ${c1.surface})`);
  check(s1.riding === null, `the flyer ended up riding ${s1.riding} — it was shoved onto the town`);
}

// ---------------------------------------------------------------------------
// 7c. ...and a flyer still LANDS on it
// ---------------------------------------------------------------------------
// The other half of every refusal above, and the one that fails if the mass is
// drawn too generously: an island you cannot fly into is worth nothing if it is
// also an island you cannot fly ONTO. The approach is from above, which is the
// only one there is, and what has to happen is the ordinary one — `carry`
// attaches him and `floorFor` puts him down on the turf.
{
  const a = (await carriers()).all[0];
  // Over open grass rather than the middle: the tower is in the middle, and a
  // flyer landing on a roof is a different (and correct) outcome that would make
  // the height assertion below mean nothing. Ten units up, inside RIDE_CEILING.
  await tp(a.x + a.radius * 0.5, a.z, a.y + 10);
  await wait(1200);
  const attached = await carriers();
  // A FLYER HOLDS ITS ALTITUDE — there is no gravity in `integrateFlying`, C is
  // the way down — so the descent is driven rather than waited for. Three
  // seconds at FLY_DIVE is 25 units against the ten he has to give up.
  await page.keyboard.down('KeyC');
  await wait(3000);
  await page.keyboard.up('KeyC');
  await wait(400);
  const s = await carriers();
  const c = s.all[0];
  const m = await page.evaluate(() => window.__dbgMount());
  results.landed = {
    attached: attached.riding, riding: s.riding,
    y: m.bodyY, surface: c.surface, over: +(m.bodyY - c.surface).toFixed(2),
  };
  check(attached.riding === island.id,
    `the flyer did not attach over the deck (riding ${attached.riding})`);
  check(s.riding === island.id, `the flyer stopped riding while landing (riding ${s.riding})`);
  // FLY_CLEARANCE is 1.3: he rests ON the turf, and the dive does not put him
  // through it — which is the floor this section guards. Diving at a deck that
  // had no floor is the same fall the report photographed, from the other side.
  check(m.bodyY - c.surface < 3,
    `the flyer is holding ${(m.bodyY - c.surface).toFixed(1)} units over the turf after a 3 s dive`);
  check(m.bodyY > c.surface, `the flyer dived through the deck (y ${m.bodyY}, turf ${c.surface})`);
  await page.evaluate(() => window.__dbgRide('off'));
}

// ---------------------------------------------------------------------------
// 8. The wood on the deck blocks
// ---------------------------------------------------------------------------
// Issue #80, second half. A tree template carries no `solid` — the overworld's
// canopies block through the per-chunk trunk registry, and a deck has no chunk —
// so the island's wood was drawn and nothing more. The fix makes the settlement
// stamp read the same `trunk` the registry reads, so this asks the collision
// query itself, at the column each tree is actually drawn in.
{
  const w = await page.evaluate(() => window.__dbgCarriedWood());
  const bare = w.trees.filter((t) => t.rise < 2);
  results.wood = {
    trees: w.trees.length,
    tallestBole: w.trees.reduce((m, t) => Math.max(m, t.rise), 0),
    withoutCollider: bare.length,
    deckSamples: w.sampled,
    raisedSamples: w.raised,
  };
  check(w.trees.length > 10, `only ${w.trees.length} trees on the island`);
  check(bare.length === 0,
    `${bare.length} of ${w.trees.length} island trees have nothing solid in their `
    + `column — first at ${JSON.stringify(bare[0])}`);
  // THE OTHER HALF: a query that answered "something is here" everywhere would
  // pass the line above and mean nothing. Most of a deck is turf and garden —
  // the settlement covers a fraction of it — so a majority of raised columns is
  // the shape of a broken query rather than of a town.
  check(w.sampled > 100, `only ${w.sampled} deck columns sampled`);
  check(w.raised < w.sampled * 0.5,
    `${w.raised} of ${w.sampled} deck columns report something solid — `
    + 'that is a deck you cannot walk on, not a settlement');
}

console.log(JSON.stringify({ ...results, fails }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
