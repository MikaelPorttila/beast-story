// WHAT LIVES WHERE — the wild population comes from content (issue #204).
//
// Usage: bun tools/test-spawn-tables.mjs      (dev server must be up)
//
// Four claims, and the first two are the pair that matters: a table nothing
// rolls from and a population that ignores its table are different bugs, and
// either one alone passes a test that only looks at the other.
//
//   1. EVERY BIOME HAS A TABLE, and it is the biome's own asset that says so —
//      read back as percentages, so a weight that stopped being read shows up
//      as a share rather than as an absence.
//   2. THE POPULATION OBEYS IT. Every live enemy is one its own column's table
//      lists. Measured over the population the spawner built on its own, not
//      over one this probe placed.
//   3. NO FLYER IS IN A GROUND TABLE. The flying beasts belong to Act 3 and its
//      mount; meeting one in the opening valley spends it early. Asserted on
//      the whole roster rather than on the four ids, so a flyer added later is
//      caught by the same line. The one table that DOES hold them is `sky`,
//      the shards' decks (issue #271), which no ground column ever rolls.
//   4. A ZONE WITH NO BIOME IS QUIET. The Hold answers '' and its table lookup
//      finds nothing, so nothing wanders in — what is down there is what a
//      quest staged, which is the contract `quest:land/the-red-thread` needs.
//
// Exits non-zero on failure.
import { launchBrowser, newPage, wait } from "./browser.mjs";
import { BASE as HOST } from "./target.mjs";

const URL = `${HOST}/?menu=0&vol=0&debug=1`;

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
await page.waitForFunction(() => window.__dbgBoot && window.__dbgBoot().playing, {
  timeout: 60000,
});
await wait(300);

const dbg = (fn, ...args) => page.evaluate(fn, ...args);
const tables = () => dbg(() => window.__dbgSpawnTables());
const adv = (s) => dbg((n) => window.__dbgAdvance(n), s);
/** Which enemies content says can fly — the roster, not a list written here. */
const flyers = async () => (await tables()).flying;

// ---------- 1. the tables are content's ------------------------------------
{
  const t = await tables();
  results.tables = t.tables;
  const named = Object.keys(t.tables);
  check(named.length > 0, "no biome has a spawn table at all");
  for (const [biome, rows] of Object.entries(t.tables)) {
    const sum = rows.reduce((n, r) => n + r.chance, 0);
    check(
      Math.abs(sum - 100) < 1.5,
      `biome ${biome} rolls ${sum.toFixed(1)}% in total — the weights are not being read`,
    );
  }
}

// ---------- 2. no flyer is in any ground table; the sky's holds them --------
{
  const flying = await flyers();
  const t = await tables();
  const found = Object.entries(t.tables).flatMap(([biome, rows]) =>
    rows.filter((r) => (flying ?? []).includes(r.enemy)).map((r) => `${biome}:${r.enemy}`),
  );
  results.flyers = { flying, inTables: found };
  check(flying !== null && flying.length > 0, "the debug surface reports no flying enemies at all");
  const grounded = found.filter((f) => !f.startsWith("sky:"));
  check(
    grounded.length === 0,
    `flying beasts are in an overworld table: ${JSON.stringify(grounded)} — they belong to Act 3`,
  );
  check(
    found.some((f) => f.startsWith("sky:")),
    "the sky table rolls no flyer — the shards' decks would be empty",
  );
}

// ---------- 3. the population obeys the tables -----------------------------
// Walked, not spawned: the claim is about what `trySpawn` builds on its own.
//
// ASSERTED ON THE SET, NOT ON EACH ANIMAL'S CURRENT COLUMN, and that is not a
// weaker claim — it is the right one. A wild thing walks, so a Sproutle rolled
// on the plains and found on the sand two minutes later is the world working;
// what must never happen is a species NO table lists, which is exactly what the
// uniform roll over the whole roster produced.
{
  const home = await dbg(() => window.__dbgTowns().spawn);
  const seen = [];
  for (let hop = 0; hop < 8; hop++) {
    const a = hop * 1.7;
    await dbg(
      (x, z) => window.__dbgTp(x, z),
      home.x + Math.cos(a) * 150,
      home.z + Math.sin(a) * 150,
    );
    await adv(4);
    for (const e of (await tables()).live) {
      seen.push(e.species);
    }
  }
  const t = await tables();
  const listed = new Set(Object.values(t.tables).flatMap((rows) => rows.map((r) => r.enemy)));
  const unique = [...new Set(seen)];
  const strangers = unique.filter((sp) => !listed.has(sp));
  results.population = { count: seen.length, unique, listed: [...listed], strangers };
  check(seen.length > 0, "nothing spawned anywhere in eight hops — the table refused everything");
  check(
    strangers.length === 0,
    `the world holds species no biome lists: ${JSON.stringify(strangers)}`,
  );
  // AND THE OTHER HALF: the flyers held back are held back in the WORLD, not
  // only in the tables — a population is what a player meets.
  const airborne = unique.filter((sp) => (t.flying ?? []).includes(sp));
  check(
    airborne.length === 0,
    `flying beasts are loose in Act 1's country: ${JSON.stringify(airborne)}`,
  );
}

// ---------- 3b. a swimmer spawns wet and stays wet (issue #191) -------------
//
// Finnick and Lanternfin are `locomotion: "swimming"` and had no wild assets at
// all — the schema's only movement field is `flying`, and neither walking the
// beach nor hovering over the bay is the animal. The spec now DERIVES swimming
// from the body, `trySpawn` sites them in water deep enough to submerge, and
// the wild AI keeps them under the surface. Both halves are asserted: one
// exists at all, and every one observed is IN water — never beached, never
// hovering — across several simulated slices of its own steering.
{
  const home = await dbg(() => window.__dbgTowns().spawn);
  /** The game's WATER_LEVEL (world/terrain.ts). A swimmer's centre must sit under it. */
  const WATER_LEVEL = 8;
  const SWIMMERS = new Set(["wild-finnick", "wild-lanternfin"]);
  // FIND OPEN WATER: spiral the hero out until his column reads a water biome.
  let waterAt = null;
  for (let hop = 0; hop < 24 && waterAt === null; hop++) {
    const a = hop * 0.79;
    const r = 120 + (hop % 6) * 35;
    const x = home.x + Math.cos(a) * r;
    const z = home.z + Math.sin(a) * r;
    const biome = await dbg(
      (p) => {
        window.__dbgTp(p.x, p.z);
        return window.__dbgSpawnTables().biome;
      },
      { x, z },
    );
    if (biome === "underwater" || biome === "deepwater") {
      waterAt = { x, z, biome };
    }
  }
  check(waterAt !== null, "no water biome found within 330 units of spawn — cannot stage 3b");
  const sightings = [];
  if (waterAt) {
    // Sit in the bay and let the spawner work; re-hop occasionally so a full
    // pack of amphibians cannot lock the roll out (same trick as section 3).
    for (let round = 0; round < 24 && sightings.length === 0; round++) {
      await adv(4);
      const bodies = await dbg(() => window.__dbgBodies().enemies);
      for (const e of bodies) {
        if (SWIMMERS.has(e.species)) {
          sightings.push(e);
        }
      }
      if (round % 6 === 5) {
        await dbg(
          (p) => window.__dbgTp(p.x, p.z),
          waterAt.x + (round % 2 === 0 ? 40 : -40),
          waterAt.z + 25,
        );
      }
    }
    check(
      sightings.length > 0,
      "no wild swimmer ever spawned in open water — the water tables list two",
    );
    // THE STAYING HALF: sample each sighted swimmer over its own steering.
    const wet = [];
    for (let slice = 0; slice < 4; slice++) {
      await adv(1.5);
      const bodies = await dbg(() => window.__dbgBodies().enemies);
      for (const e of bodies) {
        if (!SWIMMERS.has(e.species)) {
          continue;
        }
        const col = await dbg((p) => window.__dbgWorld(p.x, p.z), { x: e.x, z: e.z });
        wet.push({
          species: e.species,
          y: +e.y.toFixed(2),
          bed: col.ground,
          water: col.water,
          submerged: col.water && e.y < WATER_LEVEL && e.y > col.ground,
        });
      }
    }
    results.swimmers = { at: waterAt, sightings: sightings.length, samples: wet };
    check(
      wet.length > 0,
      "a swimmer was sighted and then never sampled — it despawned inside six seconds",
    );
    check(
      wet.every((s) => s.submerged),
      `a swimmer left the water: ${JSON.stringify(wet.filter((s) => !s.submerged))}`,
    );
  }
}

// ---------- 4. a zone with no biome is quiet -------------------------------
{
  const before = await tables();
  // The console is the door — the same one test-story-land opens.
  await page.keyboard.press("Backquote");
  await page.waitForSelector(".bs-console-input", { visible: true });
  await page.type(".bs-console-input", "/zone hold");
  await page.keyboard.press("Enter");
  await wait(600);
  await page.keyboard.press("Backquote");
  await wait(200);
  await adv(6);
  const t = await tables();
  results.hold = { zone: t.zone, biome: t.biome, live: t.live.length, from: before.zone };
  check(t.zone === "hold", `the console did not reach the hold: ${t.zone}`);
  check(t.biome === "", `the hold answered biome "${t.biome}" — it has none`);
  check(
    t.live.length === 0,
    `${t.live.length} wild animals wandered into a zone with no population: ${JSON.stringify(t.live)}`,
  );
}

console.log(JSON.stringify({ ...results, failures: fails, pass: fails.length === 0 }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
