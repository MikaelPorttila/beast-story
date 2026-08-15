// WHAT IS ALREADY TRUE COUNTS: a quest handed out after the fact is advanced
// from the state the world is in — the beast already bonded, the salvage
// already in the bag — instead of asking the player to do it again. Once per
// activation, through the same progress store the live facts write.
//
// Usage: bun tools/test-quest-replay.mjs      (dev server must be up)
//
// Four claims, each with both halves:
//
//   1. TAMED, EMPTY: Dark Water taken with no Aquaxol bonded starts at 0.
//   2. TAMED, HELD: the same quest taken WITH an Aquaxol already bonded starts
//      at 1 — the filter names the wild id (`wild-aquaxol`), the roster holds
//      the companion (`aquaxol`), and the scan resolves one to the other.
//   3. ITEMS, CAPPED: The Drowned Market taken with 12 salvage in the bag
//      starts at 8 of 8 — counted from the bag, capped at the objective.
//   4. A ZONE FILTER WAITS FOR THE FACT: The Red Thread's shard is "picked in
//      the Hold", which no bag remembers, so a shard already held counts 0.
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
const setQuest = (id, status) =>
  dbg(
    async ([q, s]) => {
      const { content } = await import("/src/content/index.ts");
      content.state.setQuestStatus(q, s);
    },
    [id, status],
  );
const progress = (id, objective) =>
  dbg(
    async ([q, o]) => {
      const { content } = await import("/src/content/index.ts");
      return content.state.progress(q, o);
    },
    [id, objective],
  );

const DARK = "quest:sea/dark-water";
const MARKET = "quest:sea/the-drowned-market";
const THREAD = "quest:land/the-red-thread";

// The campaign up to the sea act's doorstep, through the real store.
await setQuest("quest:land/the-bellwether", "completed");
await setQuest("quest:sea/salt-and-rope", "completed");
await wait(200);

// ---------- 1 + 2. a beast bonded before the quest asked ------------------
{
  await setQuest(DARK, "active");
  await wait(200);
  const empty = await progress(DARK, "tame-aquaxol");
  await setQuest(DARK, "unknown");
  await dbg(() => window.__dbgGrantBeast("aquaxol"));
  await setQuest(DARK, "active");
  await wait(200);
  const held = await progress(DARK, "tame-aquaxol");
  results.tamed = { empty, held };
  check(empty === 0, `Dark Water started at ${empty} with no Aquaxol bonded`);
  check(held === 1, `Dark Water started at ${held} with an Aquaxol already bonded, not 1`);
  await setQuest(DARK, "completed");
  await wait(200);
}

// ---------- 3. salvage already in the bag, capped at the count --------------
{
  await dbg(() => window.__dbgGive("salvage", 12));
  await setQuest(MARKET, "active");
  await wait(200);
  const salvage = await progress(MARKET, "collect-salvage");
  const lens = await progress(MARKET, "recover-component");
  results.items = { salvage, lens };
  check(salvage === 8, `collect-salvage started at ${salvage} with 12 in the bag, not 8 of 8`);
  check(lens === 0, `recover-component read ${lens} with no lens in the bag`);
}

// ---------- 4. a zone-filtered pick is not scanned ---------------------------
{
  await dbg(() => window.__dbgGive("red-shard", 1));
  await setQuest("quest:land/the-mill-road", "completed");
  await setQuest(THREAD, "active");
  await wait(200);
  const shard = await progress(THREAD, "recover-shard");
  results.zoned = { shard };
  check(shard === 0, `recover-shard (zone: hold) read ${shard} from a shard held outside the Hold`);
}

console.log(JSON.stringify(results, null, 2));
if (fails.length) {
  console.error(`\n${fails.length} failure(s):`);
  for (const f of fails) {
    console.error(`  ${f}`);
  }
}
await browser.close();
process.exit(fails.length ? 1 : 0);
