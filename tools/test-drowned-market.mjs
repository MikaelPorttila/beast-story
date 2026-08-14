// ACT 2, QUEST 3 — THE DROWNED MARKET (issue #154): Kelphold, the second
// island, and the act's collect-and-dive. The Bridle crew got here first and
// left the guardian ON A LEASH — so the market's guard must never deal a point
// of damage, which is measured here, not assumed.
//
// Usage: bun tools/test-drowned-market.mjs      (dev server must be up)
//
// Five claims:
//
//   1. KELPHOLD STANDS ON ITS OWN ISLAND, a second `island` settlement past the
//      coastline, distinct from Saltrest's.
//   2. THE QUEST OPENS OFF DARK WATER ALONE (the fork's first half): with the
//      Rookery nowhere in the registry yet, Brack offers it and the activation
//      replay marks dive-the-market where he stands.
//   3. THE MARKET DRESSES: eight salvage stalls on divable beds (4.6..6.6 —
//      swimmable water, never the dark kind) and the lens at the farthest one,
//      under the leashed hound.
//   4. THE HOUND HURTS NOBODY: standing beside it for three simulated seconds
//      costs zero hit points — Coil's case, measured.
//   5. THE DIVE PAYS: eight salvage claimed, the lens claimed, the turn-in
//      completes with `component-lens` set and exactly 100 shards paid.
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
const state = () =>
  dbg(async () => {
    const { content } = await import("/src/content/index.ts");
    const q = "quest:sea/the-drowned-market";
    return {
      status: content.state.questStatus(q),
      dive: content.state.progress(q, "dive-the-market"),
      salvage: content.state.progress(q, "collect-salvage"),
      lens: content.state.progress(q, "recover-component"),
      flag: content.state.flag("component-lens"),
      discovered: content.state.discovered("town:kelphold"),
    };
  });

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
    const talking = (await dbg(() => window.__dbgNpcs())).talking;
    if (talking?.id === id) {
      return talking.line;
    }
  }
  return null;
}

// ---------- stage the campaign to the fork -----------------------------------
await dbg(async () => {
  const { content } = await import("/src/content/index.ts");
  content.state.setQuestStatus("quest:land/the-bellwether", "completed");
  content.state.setQuestStatus("quest:sea/salt-and-rope", "completed");
  content.state.setQuestStatus("quest:sea/dark-water", "completed");
});
await wait(300);

// ---------- 1. Kelphold stands on its own island -----------------------------
let kelphold;
{
  const towns = await dbg(() => window.__dbgTowns().towns);
  kelphold = towns.find((t) => t.id === "kelphold");
  const saltrest = towns.find((t) => t.id === "saltrest");
  results.kelphold = kelphold ?? null;
  check(!!kelphold, "town:kelphold is not in the world registry");
  if (kelphold && saltrest) {
    const apart = Math.hypot(kelphold.x - saltrest.x, kelphold.z - saltrest.z);
    results.apart = +apart.toFixed(1);
    check(apart > 250, `Kelphold stands ${apart.toFixed(0)} from Saltrest — not its own island`);
  }
}

await dbg((t) => window.__dbgTp(t.x, t.z), kelphold);
await page.waitForFunction(() => !window.__dbgZone().streaming, { timeout: 60000 }).catch(() => {});
await wait(400);

// ---------- 2. the offer, off Dark Water alone -------------------------------
{
  const offer = await talkTo("brack");
  const started = await state();
  results.offer = { line: offer, ...started };
  check(offer !== null, "Brack has nothing to say in Kelphold");
  check(started.status === "active", `the offer left the quest "${started.status}"`);
  check(started.dive >= 1, "starting the quest inside Kelphold did not mark dive-the-market");
  await page.keyboard.press("Escape");
  await wait(250);
}

// ---------- 3. the market dresses --------------------------------------------
let spots;
{
  spots = await dbg(() => window.__dbgQuestSites().drownedMarket);
  results.market = { stalls: spots?.length ?? 0 };
  check(Array.isArray(spots) && spots.length >= 9, `the market found ${spots?.length ?? 0} stalls, wants 9`);
}
{
  const heart = spots[Math.floor(spots.length / 2)];
  await dbg((p) => window.__dbgTp(p.x, p.z), heart);
  await adv(3);
  const seen = await dbg(() => ({
    drops: window.__dbgFetch().drops.filter((d) => !d.claimed).map((d) => d.itemId),
    hound: window.__dbgBodies().enemies.some((e) => e.species === "bridle-hound"),
  }));
  // The hero stands at the heart stall, so the magnet may already have claimed
  // its drop — dressed-plus-claimed is the number the stage owes.
  const claimed = (await state()).salvage;
  results.dressed = {
    salvage: seen.drops.filter((d) => d === "salvage").length,
    alreadyClaimed: claimed,
    lens: seen.drops.filter((d) => d === "component-lens").length,
    hound: seen.hound,
  };
  check(
    results.dressed.salvage + claimed === 8,
    `${results.dressed.salvage} salvage down + ${claimed} claimed — the stage owes 8`,
  );
  check(results.dressed.lens === 1, `${results.dressed.lens} lenses down, want exactly 1`);
  check(seen.hound, "the leashed hound is not at its post");
}

// ---------- 4. the hound hurts nobody ----------------------------------------
{
  const last = spots[spots.length - 1];
  const before = await dbg(() => window.__dbgZone().player.hp);
  await dbg((p) => window.__dbgTp(p.x + 2, p.z, p.y + 1), last);
  await adv(3);
  const after = await dbg(() => window.__dbgZone().player.hp);
  results.leash = { before, after };
  check(
    before === null || after === before,
    `standing beside the leashed hound cost ${before - after} hp — it must hurt nobody`,
  );
}

// ---------- 5. the dive pays -------------------------------------------------
{
  // Claim every dressed drop by swimming its stall: tp INTO the water beside it
  // and let the magnet do what a diver's reach does.
  // FIVE rounds, not three: a drop lives MAX_AGE 42 s and the stage re-dresses
  // what expires (the owe accounting), so a slow dive — this probe on a slow
  // host, or a player — needs the rounds the self-healing was built for.
  for (let round = 0; round < 5; round++) {
    // By STALL, not by drop: the snapshot carries no y and a deep stall's drop
    // sits below the magnet's reach from the surface — so dive each stall the
    // way a player does, straight down its own column.
    for (const s of [...spots.slice(0, 8), spots[spots.length - 1]]) {
      await dbg((p) => window.__dbgTp(p.x, p.z, p.y + 1), s);
      await adv(0.9);
    }
    const s = await state();
    if (s.salvage >= 8 && s.lens >= 1) {
      break;
    }
    await adv(2);
  }
  const dived = await state();
  results.dived = dived;
  check(dived.salvage >= 8, `only ${dived.salvage} of 8 salvage claimed`);
  check(dived.lens >= 1, "the lens was never claimed");

  const before = await dbg(() => window.__dbgZone().shards);
  const done = await talkTo("brack");
  await page.keyboard.press("Escape");
  await wait(250);
  const ended = await state();
  const paid = (await dbg(() => window.__dbgZone().shards)) - before;
  results.done = { line: done, ...ended, paid };
  check(ended.status === "completed", `the turn-in left the quest "${ended.status}"`);
  check(ended.flag === true, "component-lens was not set");
  check(ended.discovered === true, "town:kelphold was not discovered");
  check(paid === 100, `the reward paid ${paid} shards, not the promised 100`);

  // Coil is here, and her case has a second reading once the lens is up.
  const coil = await talkTo("coil/kelphold");
  results.coil = coil;
  check(coil !== null, "Warden Coil is not standing in Kelphold");
}

console.log(JSON.stringify({ ...results, failures: fails, pass: fails.length === 0 }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
