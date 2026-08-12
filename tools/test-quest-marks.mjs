// THE MARKS OVER THE WORLD: who has work, and what a quest is counting.
//
// Usage: bun tools/test-quest-marks.mjs      (dev server must be up)
//
// A mark is derived from quest state every time quest state changes, so every
// claim here is a PAIR — the mark appears when the fact is true and is gone
// when it is not. One arm alone passes against a build that marks everybody.
//
//   1. AN OFFER IS MARKED, AND ONLY THE GIVER IS. Gain carries the campaign's
//      opening quest; the three people on the flying island do not, and a build
//      that put a "!" over every NPC would pass a test that only counted one.
//   2. TAKING THE QUEST TAKES THE MARK DOWN. The "!" means "there is work
//      here", and once you have the work it is a lie.
//   3. WHAT THE QUEST COUNTS IS MARKED. The practice objective counts orb
//      throws at a Sproutle, so the staged Sproutle wears a target ring — and
//      nothing else in the wild population does.
//   4. FINISHING THE OBJECTIVES TURNS THE MARK BACK ON, as a turn-in. Same
//      person, different mark, and the difference is the whole point of there
//      being two glyphs.
//   5. THE MARK IS DRAWN, not merely computed: the drawn list is what reached
//      the scene after the distance cull, and a policy that never renders is
//      the failure a policy-only assertion cannot see.
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
await page.waitForFunction(
  () => window.__dbgBoot && window.__dbgBoot().playing && window.__dbgQuestMarks,
  { timeout: 60000 },
);
await wait(400);

const dbg = (fn, ...args) => page.evaluate(fn, ...args);
const marks = () => dbg(() => window.__dbgQuestMarks());
const kindOn = async (id) => (await marks()).marked.npcs.find((n) => n.id === id)?.kind ?? null;

/** Stand beside a named NPC and press E until the conversation opens. */
async function talkTo(id) {
  const who = (await dbg(() => window.__dbgNpcs())).all.find((n) => n.id === id);
  if (!who) {
    return null;
  }
  await dbg((n) => window.__dbgTp(n.x + 2, n.z), who);
  await wait(300);
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press("KeyE");
    await wait(200);
    if ((await dbg(() => window.__dbgNpcs())).talking?.id === id) {
      await page.keyboard.press("Escape");
      await wait(250);
      return true;
    }
  }
  return false;
}

// ---------- 1. the offer, and only on the giver -----------------------------
{
  const m = await marks();
  const everyone = (await dbg(() => window.__dbgNpcs())).all.map((n) => n.id);
  results.offer = { marked: m.marked.npcs, npcsInWorld: everyone, drawn: m.drawn.length };
  check((await kindOn("gain")) === "offer", "the opening quest's giver wears no offer mark");
  check(
    m.marked.npcs.length === 1,
    `${m.marked.npcs.length} people are marked at boot, not 1: ${JSON.stringify(m.marked.npcs)}`,
  );
  // The hero spawns beside Gain, so his mark is inside the cull distance and
  // must have been drawn. This is the half that fails when a mark is computed
  // into a list nothing renders.
  check(
    m.drawn.some((d) => d.kind === "offer"),
    "the offer mark was computed but never drawn",
  );
}

// ---------- 2. taking the work takes the mark down --------------------------
{
  const talked = await talkTo("gain");
  const m = await marks();
  results.afterOffer = { talked, marked: m.marked, drawn: m.drawn };
  check(talked === true, "could not talk to Gain");
  check(
    (await kindOn("gain")) === null,
    `Gain still wears a "${await kindOn("gain")}" mark after the quest was taken`,
  );
}

// ---------- 3. what the quest counts is marked ------------------------------
{
  // The practice objective counts orb throws, and the quest stages a Sproutle
  // to throw at — so the beast the objective names is the one wearing a ring.
  let m = await marks();
  for (let i = 0; i < 40 && m.drawn.every((d) => d.kind !== "target"); i++) {
    await wait(250);
    m = await marks();
  }
  const wild = (await dbg(() => window.__dbgBodies())).enemies;
  results.target = {
    beasts: m.marked.beasts,
    enemies: m.marked.enemies,
    targetsDrawn: m.drawn.filter((d) => d.kind === "target").length,
    wildNearby: wild.map((e) => e.species),
  };
  check(
    m.marked.beasts.includes("sproutle") || m.marked.enemies.includes("wild-sproutle"),
    `the practice quest marks ${JSON.stringify(m.marked)} — the Sproutle it counts is not in it`,
  );
  check(results.target.targetsDrawn >= 1, "nothing wearing a target ring was drawn");
  // ...and not everything. A ring over every animal in the meadow is a ring
  // that says nothing.
  const unmarked = wild.filter((e) => e.species !== "wild-sproutle").length;
  check(
    results.target.targetsDrawn <= wild.length - unmarked + 1,
    `${results.target.targetsDrawn} rings drawn over a population of ${wild.length}`,
  );
}

// ---------- 4. done, and the mark comes back as a turn-in -------------------
{
  // Fill the objectives through the game's own path — the throws are what the
  // objective counts, and __dbgThrowOrb is the same call the key press makes.
  for (let i = 0; i < 3; i++) {
    for (let w = 0; w < 40; w++) {
      if (!(await dbg(() => window.__dbgTaming())).bonding) {
        break;
      }
      await wait(250);
    }
    await dbg(() => window.__dbgThrowOrb("wild-sproutle", false));
    await wait(500);
  }
  await page
    .waitForFunction(() => window.__dbgQuestMarks().marked.npcs.some((n) => n.kind === "turnIn"), {
      timeout: 20000,
    })
    .catch(() => {});
  const m = await marks();
  results.turnIn = { marked: m.marked, drawn: m.drawn };
  check(
    (await kindOn("gain")) === "turnIn",
    `Gain wears "${await kindOn("gain")}" with every objective met, not a turn-in mark`,
  );
  // The ring goes when the counting stops, which is the same rule read the
  // other way: a finished objective is no longer pointing at anything.
  check(
    m.marked.beasts.length === 0 && m.marked.enemies.length === 0,
    `the quest still marks ${JSON.stringify(m.marked)} with its objectives full`,
  );
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
