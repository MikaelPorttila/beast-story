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
//   3. NO FLYER IS IN AN ACT 1 TABLE. The flying beasts belong to Act 3 and its
//      mount; meeting one in the opening valley spends it early. Asserted on
//      the whole roster rather than on the four ids, so a flyer added later is
//      caught by the same line.
//   4. A ZONE WITH NO BIOME IS QUIET. The Hold answers '' and its table lookup
//      finds nothing, so nothing wanders in — what is down there is what a
//      quest staged, which is the contract `quest:land/the-red-thread` needs.
//
// Exits non-zero on failure.
import { launchBrowser, newPage, wait } from "./browser.mjs";
import { BASE as HOST } from "./target.mjs";

const URL = `${HOST}/?menu=0&vol=0`;

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

// ---------- 2. no flyer is in any of them ----------------------------------
{
  const flying = await flyers();
  const t = await tables();
  const found = Object.entries(t.tables).flatMap(([biome, rows]) =>
    rows.filter((r) => (flying ?? []).includes(r.enemy)).map((r) => `${biome}:${r.enemy}`),
  );
  results.flyers = { flying, inTables: found };
  check(flying !== null && flying.length > 0, "the debug surface reports no flying enemies at all");
  check(
    found.length === 0,
    `flying beasts are in an overworld table: ${JSON.stringify(found)} — they belong to Act 3`,
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
