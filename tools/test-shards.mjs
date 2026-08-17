// SKY SHARDS — the hovering rock clusters seeded over the whole world
// (src/world/sky-shards.ts).
//
// Usage: bun tools/test-shards.mjs      (dev server must be up)
//
// Claims:
//
//   1. THEY ARE THERE, AND OUT OF THE WAY: a seeded set of clusters, Skyhaven
//      still the first carrier, every cluster clear of every town island's roam
//      disc, and `shards=0` builds none.
//   2. THEY HOVER, AND YOU HOVER WITH THEM: a hero put on a shard rides it, and
//      over a few seconds the deck moves under him without him leaving it.
//   3. THE BRIDGE CARRIES: walked from one shard's rim to the next, the hero
//      stays supported the whole way and lands on the far rock.
//   4. THE WOODS ARE SOLID: trees are planted and drawn as colliders floored on
//      the deck, not hanging to the ground.
//   6. THE TURF IS CARPETED (issue #271): every cluster stamps a sward.
//   7. THE DECKS ARE LIVED ON (issue #271): a hero up on a cluster is joined by
//      its wilds — sky species, on the deck's own column, restocked to the
//      cluster's count — and one on the ground under the same cluster is not.
//      A wild that is there stays up: it never sinks toward the valley.
//
// Exits non-zero on failure.
import { launchBrowser, newPage, wait } from "./browser.mjs";
import { BASE as HOST, NO_WARMUP } from "./target.mjs";

const URL = `${HOST}/?menu=0&fs=0&vol=0&${NO_WARMUP}`;

const browser = await launchBrowser();
const results = {};
const fails = [];
const check = (ok, msg) => {
  if (!ok) {
    fails.push(msg);
  }
};

const page = await newPage(browser, { width: 1280, height: 800 });
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__dbgBoot?.().playing && window.__dbgAdvance, {
  timeout: 90000,
});
await wait(400);

const dbg = (fn, ...args) => page.evaluate(fn, ...args);
const adv = (s) => dbg((n) => window.__dbgAdvance(n), s);
const shards = () => dbg(() => window.__dbgShards());
const carriers = () => dbg(() => window.__dbgCarriers());
const streamed = async () => {
  for (let i = 0; i < 80 && (await dbg(() => window.__dbgZone().streaming)); i++) {
    await wait(250);
  }
};

// ---------- 1. there, and out of the way ------------------------------------
{
  const all = await shards();
  const c = await carriers();
  const towns = c.all.filter((k) => k.id.startsWith("carrier:town:"));
  results.count = all.length;
  results.first = c.all[0]?.id;
  check(all.length >= 8, `${all.length} shard clusters seeded, want at least 8`);
  check(c.all[0]?.id === "carrier:town:skyhaven", `the first carrier is ${c.all[0]?.id}`);
  check(
    all.every((s, i) => s.id === `carrier:shard:${i}`),
    "cluster ids are not stable in seed order",
  );
  // Roam disc = 260 (ROAM_R) about the island's HOME, which it has barely left at boot.
  const tooClose = all.filter((s) =>
    towns.some((t) => Math.hypot(t.x - s.x, t.z - s.z) < 260 + t.radius + s.radius),
  );
  results.tooClose = tooClose.map((s) => s.id);
  check(tooClose.length === 0, `clusters inside a town island's roam disc: ${tooClose.map((s) => s.id)}`);
  const trees = all.reduce((n, s) => n + s.trees, 0);
  results.trees = trees;
  check(trees >= all.length, `${trees} trees over ${all.length} clusters — the woods are thin`);
  check(all.some((s) => s.bridges.length > 0), "no cluster has a bridge");
}

// ---------- 2. they hover, and you hover with them --------------------------
const bridged = (await shards()).find((s) => s.bridges.length > 0);
{
  const target = bridged ?? (await shards())[0];
  await dbg((c) => window.__dbgTp(c.x, c.z, c.y + 0.3), target);
  await streamed();
  await adv(0.5);
  const samples = [];
  for (let i = 0; i < 6; i++) {
    await adv(0.8);
    const p = await dbg(() => window.__dbgPlayerPos());
    const c = (await shards()).find((s) => s.id === target.id);
    const ride = (await carriers()).riding;
    samples.push({ hero: +p.y.toFixed(2), deck: +c.y.toFixed(2), gap: +(p.y - c.y).toFixed(2), ride });
  }
  results.hover = samples;
  const deckMoved = Math.max(...samples.map((s) => s.deck)) - Math.min(...samples.map((s) => s.deck));
  check(deckMoved > 0.3, `the deck did not hover (${deckMoved.toFixed(2)} of travel in ~5 s)`);
  check(
    samples.every((s) => s.ride === target.id),
    `the hero was not riding the shard: ${JSON.stringify(samples.map((s) => s.ride))}`,
  );
  check(
    samples.every((s) => s.gap > -0.5 && s.gap < 1.5),
    `the hero left the deck: gaps ${JSON.stringify(samples.map((s) => s.gap))}`,
  );
}

// ---------- 3. the bridge carries ------------------------------------------------
if (bridged) {
  const b = bridged.bridges[0];
  const len = Math.hypot(b.bx - b.ax, b.bz - b.az);
  const bearing = Math.atan2(b.bx - b.ax, b.bz - b.az);
  await dbg((x, z, y) => window.__dbgTp(x, z, y), b.ax, b.az, bridged.y + 0.3);
  await streamed();
  await dbg((a) => window.__dbgAim(a), bearing);
  await adv(0.6);
  const lows = [];
  await page.keyboard.down("KeyW");
  const steps = Math.ceil((len / 5 + 1) / 0.25);
  for (let i = 0; i < steps; i++) {
    await adv(0.25);
    const p = await dbg(() => window.__dbgPlayerPos());
    const c = (await shards()).find((s) => s.id === bridged.id);
    lows.push(+(p.y - c.y).toFixed(2));
  }
  await page.keyboard.up("KeyW");
  await adv(0.3);
  const end = await dbg(() => window.__dbgPlayerPos());
  const c = (await shards()).find((s) => s.id === bridged.id);
  // How far ALONG the bridge he got (he may well overshoot onto the far rock).
  const bb = c.bridges[0];
  const along = ((end.x - bb.ax) * (bb.bx - bb.ax) + (end.z - bb.az) * (bb.bz - bb.az)) / len;
  results.bridge = { len: +len.toFixed(1), lowest: Math.min(...lows), along: +along.toFixed(1), riding: (await carriers()).riding };
  check(Math.min(...lows) > -0.6, `the hero dropped ${Math.min(...lows)} under the deck on the bridge`);
  check(along > len - 2, `the walk got ${along.toFixed(1)} of ${len.toFixed(1)} along the bridge — it did not carry him over`);
  check((await carriers()).riding === bridged.id, "the hero was not riding the cluster at the far end");
} else {
  check(false, "no bridged cluster to walk");
}

// ---------- 4. the woods are solid ------------------------------------------------
{
  const v = await dbg(() => window.__dbgColliderView(true));
  await dbg(() => window.__dbgColliderView(false));
  results.cages = { tallest: v.tallest, carried: v.carried, boxes: v.boxes };
  // The tallest correct cage in the world is Skyhaven's tower (36); a tree drawn from
  // the ground under a shard would be a hundred-odd.
  check(v.tallest < 60, `a cage of ${v.tallest} units at ${JSON.stringify(v.tallestAt)} — a shard tree hangs to the ground`);
}

// ---------- 5. a standing stone on a shard ----------------------------------------
{
  const withStone = (await shards()).find((s) => s.waypoint);
  check(!!withStone, "no cluster earned a waystone");
  if (withStone) {
    const stone = (await dbg(() => window.__dbgWaypoints())).all.find((w) => w.id === withStone.waypoint);
    check(!!stone, `${withStone.waypoint} is not in the world's waypoint field`);
    check(stone && stone.y > 80, `the shard's stone is at y=${stone?.y}, not up on the deck`);
    // NOTICED: stand beside it on the deck, and it lights like a road stone.
    await dbg((w) => window.__dbgTp(w.x + 2, w.z, w.y + 0.3), stone);
    await streamed();
    await adv(1.5);
    const lit = (await dbg(() => window.__dbgWaypoints())).all.find((w) => w.id === withStone.waypoint);
    check(lit?.lit === true, "standing beside the shard's stone did not light it");
    // ...and it hovers with the rock: the field's y follows the deck.
    const ys = [lit.y];
    for (let i = 0; i < 5; i++) {
      await adv(1);
      ys.push((await dbg(() => window.__dbgWaypoints())).all.find((w) => w.id === withStone.waypoint).y);
    }
    const swing = Math.max(...ys) - Math.min(...ys);
    check(swing > 0.3, `the stone's published height did not follow the hover (${JSON.stringify(ys)})`);
    // A FAINT WAKES UP ON IT — on the deck, not on the ground a hundred units under.
    await dbg((w) => window.__dbgTp(w.x + 30, w.z + 30), stone);
    await streamed();
    await adv(0.5);
    await dbg(() => window.__dbgHurt(99999));
    for (let i = 0; i < 80 && (await dbg(() => window.__dbgZone().player.hp)) <= 0; i++) {
      await adv(0.25);
    }
    await adv(0.5);
    const p = await dbg(() => window.__dbgPlayerPos());
    const c = (await shards()).find((s) => s.id === withStone.id);
    results.revive = { x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1), deck: +c.y.toFixed(1), riding: (await carriers()).riding };
    check(Math.hypot(p.x - stone.x, p.z - stone.z) < 4, `the revival put him ${Math.hypot(p.x - stone.x, p.z - stone.z).toFixed(1)} from the stone`);
    check(p.y > c.y - 0.6, `the revival dropped him to y=${p.y.toFixed(1)} under the deck at ${c.y.toFixed(1)}`);
  }
}

// ---------- 6. the turf is carpeted --------------------------------------------------
{
  const all = await shards();
  const bare = all.filter((s) => s.clumps === 0 || s.swardVerts === 0);
  results.sward = {
    clumps: all.reduce((n, s) => n + s.clumps, 0),
    verts: all.reduce((n, s) => n + s.swardVerts, 0),
  };
  check(bare.length === 0, `clusters with no sward: ${bare.map((s) => s.id)}`);
}

// ---------- 7. the decks are lived on -----------------------------------------------
{
  const cl = (await shards()).reduce((a, b) => (b.wilds > a.wilds ? b : a));
  const sky = await dbg(() => window.__dbgSpawnTables().tables.sky ?? []);
  const skyIds = sky.map((r) => r.enemy);
  check(skyIds.length > 0, "biome:sky has no spawn table");
  const on = async () =>
    (await dbg(() => window.__dbgBodies().enemies)).filter(
      (e) =>
        e.targetable &&
        Math.hypot(e.x - cl.x, e.z - cl.z) < cl.radius + 8 &&
        Math.abs(e.y - cl.y) < 25,
    );
  // THE GROUND HALF FIRST: stood under the cluster, nothing is stocked on it.
  await dbg((c) => window.__dbgTp(c.x, c.z), cl);
  await streamed();
  await adv(4);
  const below = await on();
  results.wildsFromGround = below.length;
  check(
    below.length === 0,
    `${below.length} wilds stocked on ${cl.id} while the hero was on the ground under it`,
  );
  // UP ON IT: the population arrives, sky species, standing on the deck's column.
  await dbg((c) => window.__dbgTp(c.x, c.z, c.y + 0.3), cl);
  await streamed();
  let up = [];
  for (let i = 0; i < 12 && up.length < cl.wilds; i++) {
    await adv(1);
    up = await on();
  }
  results.wilds = { want: cl.wilds, have: up.length, species: up.map((e) => e.species) };
  check(up.length >= cl.wilds, `${up.length} of ${cl.wilds} wilds on ${cl.id} after 12 s up on it`);
  check(
    up.every((e) => skyIds.includes(e.species)),
    `a deck wild is not from the sky table: ${up.map((e) => e.species)}`,
  );
  // ON THE DECK'S COLUMN, not the ground's: a flyer cruises a few units over the turf.
  const deckY = (await shards()).find((s) => s.id === cl.id).y;
  const rises = up.map((e) => +(e.y - deckY).toFixed(2));
  results.wildRise = rises;
  check(
    rises.every((r) => r > -0.5 && r < 8),
    `a deck wild is not over the deck: rises ${JSON.stringify(rises)}`,
  );
  // AND IT STAYS UP: seconds later every one is still within the deck's band.
  await adv(6);
  const later = await on();
  check(
    later.length >= Math.min(up.length, cl.wilds),
    `wilds left the cluster's band: ${up.length} -> ${later.length}`,
  );
}

// ---------- 1b. shards=0 --------------------------------------------------------------
{
  const off = await newPage(browser, { width: 900, height: 600 });
  await off.goto(`${HOST}/?menu=0&fs=0&vol=0&${NO_WARMUP}&shards=0`, { waitUntil: "domcontentloaded" });
  await off.waitForFunction(() => window.__dbgBoot?.().playing && window.__dbgAdvance, { timeout: 90000 });
  const n = await off.evaluate(() => window.__dbgShards().length);
  results.off = n;
  check(n === 0, `shards=0 still built ${n} clusters`);
  await off.close();
}

console.log(JSON.stringify({ ...results, failures: fails, pass: fails.length === 0 }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
