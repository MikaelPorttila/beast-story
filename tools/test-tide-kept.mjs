// ACT 2, QUEST 5 — WHAT THE TIDE KEPT (issue #156): the act's closer, its boss,
// and the Act 2 -> Act 3 seam. Also the epic's fork proof (issue #144 DoD): the
// closer must become available with quests 3 and 4 done in EITHER order, and in
// neither order early.
//
// Usage: bun tools/test-tide-kept.mjs      (dev server must be up)
//
// Five claims:
//
//   1. THE FORK, BOTH ORDERS: market-then-rookery and rookery-then-market each
//      put the closer on the shelf — and one arm alone never does. Driven by
//      resetting the pair through the real state store between orders.
//   2. MAW'S REST IS A RING OF FIGHTING WATER: a sited arena down the lobe, on
//      beds a swimmer can fight over, never the unswimmable dark.
//   3. THE BOSS RISES AND FALLS: the stage marks the arrival (a landmark is not
//      a town), stands the Brineholder up, and its death marks the defeat.
//   4. THE SEAM CLOSES: Coil's turn-in assembles the device — device-built,
//      sky-revealed, act-2-complete all set, 200 paid. And its RECEIVING half
//      (issue #157): The Long Ascent is the main quest on the shelf, and Corwin
//      Vane on Skyhaven's deck — the fallback door for whoever rode up without
//      asking — offers and closes it: act-3-open set, the town discovered, 100
//      paid. The intended door, the wreck and the ride, is test-long-ascent.
//   5. THE ARENA OUTLIVES ITS BOSS (Act 4's anchor): with the act closed the
//      ring is re-enterable and nothing respawns in it.
//
// Exits non-zero on failure.
import { launchBrowser, newPage, wait } from "./browser.mjs";
import { BASE as HOST, NO_WARMUP } from "./target.mjs";

const URL = `${HOST}/?menu=0&fs=0&vol=0&${NO_WARMUP}`;
const Q5 = "quest:sea/what-the-tide-kept";
const Q3 = "quest:sea/the-drowned-market";
const Q4 = "quest:sea/the-rookery";

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
const setQuest = (id, status) =>
  dbg(
    async ([q, s]) => {
      const { content } = await import("/src/content/index.ts");
      content.state.setQuestStatus(q, s);
    },
    [id, status],
  );
const shelfOf = (id) =>
  dbg((q) => window.__dbgJournal().model.find((e) => e.id === q)?.tab ?? null, id);
const state = () =>
  dbg(async () => {
    const { content } = await import("/src/content/index.ts");
    const q = "quest:sea/what-the-tide-kept";
    return {
      status: content.state.questStatus(q),
      reach: content.state.progress(q, "reach-maws-rest"),
      defeat: content.state.progress(q, "defeat-brineholder"),
      device: content.state.progress(q, "assemble-the-device"),
      deviceBuilt: content.state.flag("device-built"),
      skyRevealed: content.state.flag("sky-revealed"),
      act2: content.state.flag("act-2-complete"),
    };
  });

async function talkTo(id) {
  const who = (await dbg(() => window.__dbgNpcs())).all.find((n) => n.id === id);
  if (!who) {
    return null;
  }
  // A resident of a CARRIED town stands well above the ground under him, so
  // the teleport carries his height — the deck is where he is, not the terrain.
  await dbg((n) => window.__dbgTp(n.x + 2, n.z, n.y - n.ground > 3 ? n.y + 0.3 : undefined), who);
  await wait(300);
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press("KeyE");
    await wait(200);
    const talking = (await dbg(() => window.__dbgNpcs())).talking;
    if (talking?.id === id) {
      return talking.line;
    }
  }
  return null;
}

// ---------- stage to the fork's root -----------------------------------------
await dbg(async () => {
  const { content } = await import("/src/content/index.ts");
  content.state.setQuestStatus("quest:land/the-bellwether", "completed");
  content.state.setQuestStatus("quest:sea/salt-and-rope", "completed");
  content.state.setQuestStatus("quest:sea/dark-water", "completed");
});
await wait(300);

// ---------- 1. the fork, both orders -----------------------------------------
{
  const orders = [
    { name: "market-then-rookery", first: Q3, second: Q4 },
    { name: "rookery-then-market", first: Q4, second: Q3 },
  ];
  results.fork = {};
  for (const order of orders) {
    await setQuest(Q3, "unknown");
    await setQuest(Q4, "unknown");
    await wait(200);
    const before = await shelfOf(Q5);
    await setQuest(order.first, "completed");
    await wait(200);
    const half = await shelfOf(Q5);
    await setQuest(order.second, "completed");
    await wait(200);
    const after = await shelfOf(Q5);
    results.fork[order.name] = { before, half, after };
    check(before === null, `${order.name}: the closer sat on "${before}" with neither arm done`);
    check(half === null, `${order.name}: the closer sat on "${half}" with only ${order.first} done`);
    check(after === "available", `${order.name}: the closer read "${after}", not "available"`);
  }
}

// ---------- 2. Maw's Rest is fighting water ----------------------------------
let ring;
{
  ring = await dbg(() => window.__dbgQuestSites().mawsRest);
  results.ring = ring ?? null;
  check(!!ring, "Maw's Rest found no site — the reef ring is missing");
  if (ring) {
    check(
      ring.y > 4 && ring.y < 8,
      `the ring's bed is ${ring.y} — not water a swimmer can fight over`,
    );
  }
}

// ---------- 3. the boss rises and falls --------------------------------------
{
  const offer = await talkTo("coil/kelphold");
  results.offer = { line: offer, status: (await state()).status };
  check(offer !== null, "Coil has no closer to give");
  check((await state()).status === "active", "the offer did not start the closer");
  await page.keyboard.press("Escape");
  await wait(250);

  await dbg((p) => window.__dbgTp(p.x + 6, p.z), ring);
  await page.waitForFunction(() => !window.__dbgZone().streaming, { timeout: 60000 }).catch(() => {});
  let boss = false;
  for (let i = 0; i < 24 && !boss; i++) {
    await adv(0.5);
    boss = await dbg(() =>
      window.__dbgBodies().enemies.some((e) => e.targetable && e.species === "brineholder"),
    );
  }
  const arrived = await state();
  results.arena = { reach: arrived.reach, boss };
  check(arrived.reach >= 1, "swimming into the ring did not mark reach-maws-rest");
  check(boss, "the Brineholder never rose");

  await dbg(() => window.__dbgKillEnemy("brineholder"));
  await adv(1);
  const felled = await state();
  results.felled = { defeat: felled.defeat };
  check(felled.defeat >= 1, "the Brineholder's death did not mark the defeat");
}

// ---------- 4. the seam closes ----------------------------------------------
{
  const before = await dbg(() => window.__dbgZone().shards);
  const done = await talkTo("coil/kelphold");
  await page.keyboard.press("Escape");
  await wait(250);
  const ended = await state();
  const paid = (await dbg(() => window.__dbgZone().shards)) - before;
  results.done = { line: done, ...ended, paid };
  check(ended.status === "completed", `the turn-in left the closer "${ended.status}"`);
  check(ended.device >= 1, "assemble-the-device was not marked");
  check(ended.deviceBuilt === true, "device-built was not set");
  check(ended.skyRevealed === true, "sky-revealed was not set — Act 3 has no key");
  check(ended.act2 === true, "act-2-complete was not set");
  check(paid === 200, `the reward paid ${paid} shards, not the promised 200`);

  // AND THE RECEIVING HALF (issue #157): `story-sky` is boot-resident like the
  // sea (the sky is part of the open world), and the prerequisite just handed in
  // puts The Long Ascent on the shelf as the ONE main quest offered with the act
  // closed. Polled: the shelf refreshes on the store's own change.
  let seam = null;
  for (let i = 0; i < 40 && seam?.tab !== "available"; i++) {
    await wait(250);
    seam = await dbg(() => {
      const c = window.__dbgContent();
      const main = window
        .__dbgJournal()
        .model.filter(
          (e) => e.category === "main" && (e.tab === "active" || e.tab === "available"),
        );
      return {
        packages: c.packages.map((p) => p.id),
        diagnostics: c.diagnostics,
        tab: main.find((e) => e.id === "quest:sky/the-long-ascent")?.tab ?? null,
        shelf: main.map((e) => e.id),
      };
    });
  }
  results.seam = seam;
  check(seam.packages.includes("story-sky"), "story-sky is not resident");
  check(seam.tab === "available", `the-long-ascent is on the "${seam.tab}" shelf, not "available"`);
  check(
    seam.diagnostics.length === 0,
    `the act's entry raised findings: ${JSON.stringify(seam.diagnostics)}`,
  );
  // Nothing of Act 2 is left offered or active — the staging above left Act 1's
  // own opener on the shelf, which is that act's business, not this seam's.
  const seaLeft = seam.shelf.filter((id) => id.startsWith("quest:sea/"));
  check(
    seaLeft.length === 0,
    `the act closed with its own quests still on the shelf: ${JSON.stringify(seaLeft)}`,
  );
}

// ---------- 4b. the pilot, home: the receiving half plays --------------------
// Vane's rows are gated on knows-the-sky, which the Rookery set above; the
// probe lands on Skyhaven's deck (the town rides a carrier, so `y` is his) and
// talks him through offer and turn-in.
{
  const vane = (await dbg(() => window.__dbgNpcs())).all.find((n) => n.id === "sky-pilot");
  check(!!vane, "npc:sky-pilot is not in the world");
  const before = await dbg(() => window.__dbgZone().shards);
  const offer = await talkTo("sky-pilot");
  await page.keyboard.press("Escape");
  await adv(0.5);
  const sky = () =>
    dbg(async () => {
      const { content } = await import("/src/content/index.ts");
      const q = "quest:sky/the-long-ascent";
      return {
        status: content.state.questStatus(q),
        board: content.state.progress(q, "board-the-balloon"),
        reach: content.state.progress(q, "reach-skyhaven"),
        act3: content.state.flag("act-3-open"),
        discovered: content.state.discovered("town:skyhaven"),
      };
    });
  const started = await sky();
  results.ascent = { offer, ...started };
  check(offer !== null, "Vane has no Long Ascent offer on the deck");
  check(started.status === "active", `the offer left the ascent "${started.status}"`);
  check(started.board >= 1, "boarding was not marked by the offer");
  check(started.reach >= 1, "standing in Skyhaven did not mark reach-skyhaven on activation");

  const done = await talkTo("sky-pilot");
  await page.keyboard.press("Escape");
  await wait(250);
  const closed = await sky();
  const paid = (await dbg(() => window.__dbgZone().shards)) - before;
  results.ascentDone = { line: done, ...closed, paid };
  check(closed.status === "completed", `the turn-in left the ascent "${closed.status}"`);
  check(closed.act3 === true, "act-3-open was not set");
  check(closed.discovered === true, "town:skyhaven was not discovered");
  check(paid === 100, `the ascent paid ${paid} shards, not the promised 100`);
}

// ---------- 5. the arena outlives its boss -----------------------------------
{
  await dbg((p) => window.__dbgTp(p.x, p.z), ring);
  await adv(4);
  const after = await dbg(() => ({
    p: window.__dbgPlayerPos(),
    boss: window.__dbgBodies().enemies.some((e) => e.species === "brineholder"),
  }));
  const d = Math.hypot(after.p.x - ring.x, after.p.z - ring.z);
  results.reentry = { d: +d.toFixed(1), boss: after.boss };
  check(d < 12, `the ring refused re-entry — the hero ended ${d.toFixed(1)} out`);
  check(!after.boss, "the Brineholder respawned with the act closed — the arena must be a place again");
}

console.log(JSON.stringify({ ...results, failures: fails, pass: fails.length === 0 }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
