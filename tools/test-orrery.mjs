// ACT 3, QUESTS 3-5 — LANTERNFALL, CINDERHELM, THE ORRERY (issues #159, #160,
// #161): the fork, the two arms, and the act's closer, played on decks.
//
// Usage: bun tools/test-orrery.mjs      (dev server must be up)
//
// Claims:
//
//   1. THE FORK, BOTH ORDERS: lanternfall-then-cinderhelm and the reverse each
//      put The Orrery on the shelf — and one arm alone never does.
//   2. LANTERNFALL: the oil waits at Skyhaven's mooring — ON the deck, riding
//      the island — six casks; picked up they count. Four galleries on
//      Lanternfall are DARK (issue #266): E at one with a cask pours it in,
//      the lamp lights, a cask leaves the bag and relight-galleries counts;
//      Tobin refuses to close with a gallery dark and closes once all four
//      burn: component-lantern, ashgrove-reunited, 140 paid.
//   3. CINDERHELM: the shelf is not the descent (issue #265) — the vent under
//      it is a zone, its arch rides the deck, and `/zone vent` takes it here
//      (test-vent drives the crossing itself); the Cinderguard stands up at the
//      vent's floor, its death leaves the record where it fell, the way back
//      up lands on the deck, and Pell closes it: knows-the-cities-built-it set,
//      160 paid. The shelf takes him again with the boss dead (#160).
//   4. THE ORRERY: reaching the deck marks the arrival, the Choirguard stands
//      up and falls, Vess closes it — vess-truth, act-3-complete, 250 paid —
//      and the frame outlives its boss: re-enterable, nothing respawns.
//
// Exits non-zero on failure.
import { launchBrowser, newPage, wait } from "./browser.mjs";
import { BASE as HOST, NO_WARMUP } from "./target.mjs";

// `debug=1` for the console: `/zone` is how this reaches the vent without a crossing.
const URL = `${HOST}/?menu=0&fs=0&vol=0&debug=1&${NO_WARMUP}`;
const Q3 = "quest:sky/lanternfall";
const Q4 = "quest:sky/cinderhelm";
const Q5 = "quest:sky/the-orrery";

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
const facts = (q, keys, flags) =>
  dbg(
    async ([id, ks, fs]) => {
      const { content } = await import("/src/content/index.ts");
      const out = { status: content.state.questStatus(id) };
      for (const k of ks) {
        out[k] = content.state.progress(id, k);
      }
      for (const f of fs) {
        out[f] = content.state.flag(f);
      }
      return out;
    },
    [q, keys, flags],
  );
const shards = () => dbg(() => window.__dbgZone().shards);
const isle = (town) =>
  dbg((t) => {
    const k = window.__dbgCarriers().all.find((c) => c.id === `carrier:town:${t}`);
    return k ? { x: k.x, y: k.y, z: k.z, r: k.radius } : null;
  }, town);
const enemies = (species) =>
  dbg((sp) => window.__dbgBodies().enemies.filter((e) => e.species === sp && !e.isDead), species);
const drops = (item) =>
  dbg((id) => window.__dbgFetch().drops.filter((d) => d.itemId === id && !d.claimed), item);
const streamed = async () => {
  for (let i = 0; i < 80 && (await dbg(() => window.__dbgZone().streaming)); i++) {
    await wait(250);
  }
};
const tpDeck = async (spot) => {
  await dbg((p) => window.__dbgTp(p.x, p.z, p.y + 0.3), spot);
  await streamed();
  await adv(0.5);
};

async function talkTo(id) {
  // The crew stand close on a deck and E talks to the NEAREST, so stand on the
  // target's far side from whoever is next to him — re-read each try, the deck moves.
  for (let attempt = 0; attempt < 4; attempt++) {
    const all = (await dbg(() => window.__dbgNpcs())).all;
    const who = all.find((n) => n.id === id);
    if (!who) {
      return null;
    }
    let ax = 0;
    let az = 0;
    for (const o of all) {
      const d = Math.hypot(o.x - who.x, o.z - who.z);
      if (o.id !== id && d < 8) {
        ax += (who.x - o.x) / d;
        az += (who.z - o.z) / d;
      }
    }
    // And away from a carried town's middle: the tower stands there, and a spot
    // inside its footprint is a spot on its roof, which the ride will not take.
    const home = await dbg(
      (t) => window.__dbgCarriers().all.find((k) => k.id === `carrier:town:${t}`) ?? null,
      who.town,
    );
    if (home && Math.hypot(home.x - who.x, home.z - who.z) < 12) {
      const d = Math.hypot(who.x - home.x, who.z - home.z) || 1;
      ax += ((who.x - home.x) / d) * 2;
      az += ((who.z - home.z) / d) * 2;
    }
    const len = Math.hypot(ax, az);
    const dx = len > 0 ? (ax / len) * 1.6 : 1.6;
    const dz = len > 0 ? (az / len) * 1.6 : 0;
    await dbg(
      (n, ox, oz) => window.__dbgTp(n.x + ox, n.z + oz, n.y - n.ground > 3 ? n.y + 0.3 : undefined),
      who,
      dx,
      dz,
    );
    await streamed();
    await adv(0.3);
    await wait(250);
    await page.keyboard.press("KeyE");
    await wait(250);
    const talking = (await dbg(() => window.__dbgNpcs())).talking;
    if (talking?.id === id) {
      await page.keyboard.press("Escape");
      await wait(200);
      return talking.line;
    }
    if (talking) {
      await page.keyboard.press("Escape");
      await wait(200);
    }
  }
  return null;
}

/** One console line, the way test-story-land drives it. */
async function cmd(line) {
  await page.keyboard.press("Backquote");
  await page.waitForSelector(".bs-console-input", { visible: true });
  await page.type(".bs-console-input", line);
  await page.keyboard.press("Enter");
  await wait(300);
  await page.keyboard.press("Backquote");
  await wait(150);
}

/** Poll until `fn` returns something truthy, advancing the sim between reads. */
async function until(fn, tries = 24, step = 0.5) {
  let v = null;
  for (let i = 0; i < tries && !v; i++) {
    await adv(step);
    v = await fn();
  }
  return v;
}

// ---------- stage to the fork's root -----------------------------------------
await dbg(async () => {
  const { content } = await import("/src/content/index.ts");
  for (const q of [
    "quest:land/the-mill-road",
    "quest:land/the-bellwether",
    "quest:sea/salt-and-rope",
    "quest:sea/dark-water",
    "quest:sea/the-drowned-market",
    "quest:sea/the-rookery",
    "quest:sea/what-the-tide-kept",
    "quest:sky/the-long-ascent",
    "quest:sky/wingbroken",
  ]) {
    content.state.setQuestStatus(q, "completed");
  }
});
await adv(0.3);

// ---------- 1. the fork, both orders -----------------------------------------
{
  results.fork = {};
  for (const order of [
    { name: "lanternfall-then-cinderhelm", first: Q3, second: Q4 },
    { name: "cinderhelm-then-lanternfall", first: Q4, second: Q3 },
  ]) {
    await setQuest(Q3, "unknown");
    await setQuest(Q4, "unknown");
    await adv(0.2);
    const before = await shelfOf(Q5);
    await setQuest(order.first, "completed");
    await adv(0.2);
    const half = await shelfOf(Q5);
    await setQuest(order.second, "completed");
    await adv(0.2);
    const both = await shelfOf(Q5);
    results.fork[order.name] = { before, half, both };
    check(before !== "available", `${order.name}: the closer is offered with neither arm done`);
    check(half !== "available", `${order.name}: the closer is offered with one arm done`);
    check(both === "available", `${order.name}: the closer is not offered with both arms done`);
  }
  await setQuest(Q3, "unknown");
  await setQuest(Q4, "unknown");
  await adv(0.2);
}

// ---------- 2. Lanternfall ------------------------------------------------------
{
  const shelf = await shelfOf(Q3);
  check(shelf === "available", `Lanternfall is on the "${shelf}" shelf with Wingbroken done`);
  const offer = await talkTo("sky-lamplighter/lanternfall");
  check(offer !== null, "Tobin at Lanternfall has no offer");
  let s = await facts(Q3, ["carry-oil", "relight-galleries"], []);
  check(s.status === "active", `Tobin's offer left Lanternfall "${s.status}"`);

  // The oil is at SKYHAVEN's mooring, on the deck.
  const m = (await dbg(() => window.__dbgBalloon())).stops.find((x) => x.id === "skyhaven-mooring");
  const sky0 = await isle("skyhaven");
  // Six units inboard of the pad: on the pad itself the magnet takes a cask the frame it lands.
  const inb = Math.hypot(sky0.x - m.x, sky0.z - m.z);
  await tpDeck({ x: m.x + ((sky0.x - m.x) / inb) * 6, y: m.y, z: m.z + ((sky0.z - m.z) / inb) * 6 });
  const casks = await until(async () => {
    const d = await drops("lamp-oil");
    return d.length >= 6 ? d : null;
  });
  const sky = await isle("skyhaven");
  results.oil = {
    casks: casks?.length ?? 0,
    onDeck: casks?.filter((d) => d.y > sky.y - 1 && Math.hypot(d.x - sky.x, d.z - sky.z) < sky.r).length,
  };
  check(casks && casks.length === 6, `${casks?.length ?? 0} casks at the mooring, want 6`);
  check(results.oil.onDeck === 6, "a cask is not resting on the deck");
  // Picked by walking onto each; the magnet does the rest.
  for (let i = 0; i < 14; i++) {
    const d = await drops("lamp-oil");
    if (d.length === 0) {
      break;
    }
    await dbg((p) => window.__dbgTp(p.x, p.z, p.y + 0.3), d[0]);
    await adv(1.2);
  }
  s = await facts(Q3, ["carry-oil", "relight-galleries"], []);
  results.carried = s;
  check(s["carry-oil"] >= 6, `carry-oil counted ${s["carry-oil"]}, want 6`);
  await adv(2);
  const restocked = await drops("lamp-oil");
  check(restocked.length === 0, `the mooring restocked ${restocked.length} casks after all six were carried`);

  // With every cask carried and no gallery lit, Tobin does not close.
  const early = await talkTo("sky-lamplighter/lanternfall");
  s = await facts(Q3, ["relight-galleries"], []);
  results.early = { line: early, ...s };
  check(s.status === "active", `Tobin closed Lanternfall with every gallery dark ("${s.status}")`);

  // The four dark galleries, lit one by one: E at each with a cask in the bag.
  const lamps = () => dbg(() => window.__dbgLamps());
  const bagOil = () =>
    dbg(() => window.__dbgInventory().bag.find((e) => e.id === "lamp-oil")?.count ?? 0);
  const oilBefore = await bagOil();
  const dark0 = (await lamps()).all.filter((l) => l.town === "lanternfall" && !l.lit);
  results.lamps = { dark: dark0.length };
  check(dark0.length === 4, `Lanternfall has ${dark0.length} dark galleries, want 4`);
  for (let i = 0; i < 4; i++) {
    const cur = (await lamps()).all.filter((l) => l.town === "lanternfall" && !l.lit);
    if (cur.length === 0) {
      break;
    }
    // Re-read each time: the island moves. Stand a stride short of the plinth's middle.
    const l = cur[0];
    const home = await isle("lanternfall");
    const d = Math.hypot(l.x - home.x, l.z - home.z) || 1;
    await dbg((p) => window.__dbgTp(p.x, p.z, p.y + 0.3), {
      x: l.x + ((l.x - home.x) / d) * 3.2,
      y: l.y,
      z: l.z + ((l.z - home.z) / d) * 3.2,
    });
    await streamed();
    await adv(0.3);
    const near = (await lamps()).near;
    check(near === l.id, `standing at ${l.id} the hero is near "${near}"`);
    await page.keyboard.press("KeyE");
    await adv(0.3);
    const after = (await lamps()).all.find((x) => x.id === l.id);
    check(after?.lit === true, `E at ${l.id} did not light it`);
  }
  s = await facts(Q3, ["relight-galleries"], []);
  results.relit = s;
  check(
    s["relight-galleries"] === 4,
    `relight-galleries counted ${s["relight-galleries"]}, want 4`,
  );
  // Four casks poured of the six carried: the objective cost the item.
  const oilAfter = await bagOil();
  results.oil.poured = oilBefore - oilAfter;
  check(oilBefore - oilAfter === 4, `pouring cost ${oilBefore - oilAfter} casks, want 4`);

  const before = await shards();
  const done = await talkTo("sky-lamplighter/lanternfall");
  const closed = await facts(Q3, ["relight-galleries"], ["component-lantern", "ashgrove-reunited"]);
  const paid = (await shards()) - before;
  results.lanternfall = { done, ...closed, paid };
  check(closed.status === "completed", `Tobin's turn-in left Lanternfall "${closed.status}"`);
  check(closed["relight-galleries"] >= 4, "the galleries were not relit");
  check(closed["component-lantern"] === true, "component-lantern was not set");
  check(closed["ashgrove-reunited"] === true, "ashgrove-reunited was not set");
  check(paid === 140, `Lanternfall paid ${paid}, not the promised 140`);
}

// ---------- 3. Cinderhelm -------------------------------------------------------
{
  const offer = await talkTo("sky-gardener");
  check(offer !== null, "Mother Pell has no Cinderhelm offer");
  let s = await facts(Q4, ["descend-the-vent"], []);
  check(s.status === "active", `Pell's offer left Cinderhelm "${s.status}"`);
  const cinder = await isle("cinderhelm");
  check(!!cinder, "Cinderhelm is not a carrier in this world");
  await tpDeck({ x: cinder.x + 20, y: cinder.y, z: cinder.z });
  s = await facts(Q4, ["descend-the-vent"], []);
  check(s["descend-the-vent"] === 0, "standing on Cinderhelm's deck counted as the descent");
  // The way down is an arch ON the deck, riding it (test-vent walks through it).
  const arch = (await dbg(() => window.__dbgZone().gates)).find((g) => g.to === "vent");
  results.arch = arch;
  check(!!arch && arch.carried === true, "the overworld has no carried gate to the vent");
  check(
    !!arch && Math.hypot(arch.x - cinder.x, arch.z - cinder.z) < cinder.r,
    "the vent's arch does not stand on Cinderhelm",
  );
  await cmd("/zone vent");
  await streamed();
  await adv(0.3);
  check((await dbg(() => window.__dbgZone().id)) === "vent", "the console did not reach the vent");
  s = await facts(Q4, ["descend-the-vent"], []);
  check(s["descend-the-vent"] >= 1, "arriving in the vent did not mark the descent");
  const floor = (await dbg(() => window.__dbgQuestSites())).ventFloor;
  await dbg((p) => window.__dbgTp(p.x, p.z), floor);
  await streamed();
  const guard = await until(async () => {
    const e = await enemies("cinderguard");
    return e.length > 0 && e[0].targetable ? e[0] : null;
  });
  results.cinderguard = guard;
  check(!!guard, "the Cinderguard did not stand up at the vent's floor");
  check(
    !!guard && Math.hypot(guard.x - floor.x, guard.z - floor.z) < 12,
    "the Cinderguard is not at the floor room",
  );
  await dbg(() => window.__dbgKillEnemy("cinderguard"));
  await adv(0.5);
  s = await facts(Q4, ["defeat-cinderguard"], []);
  check(s["defeat-cinderguard"] >= 1, "the Cinderguard's death did not mark the defeat");
  const record = await until(async () => {
    const d = await drops("the-record");
    return d.length > 0 ? d[0] : null;
  });
  check(!!record, "the record did not appear where the guardian fell");
  if (record) {
    await dbg((p) => window.__dbgTp(p.x, p.z), record);
    await adv(1.2);
  }
  s = await facts(Q4, ["recover-the-record"], []);
  check(s["recover-the-record"] >= 1, "picking up the record did not count");
  // Back up: a door on a deck lands you on the deck, not at the camp.
  await cmd("/zone overworld");
  await streamed();
  await adv(0.5);
  const up = await isle("cinderhelm");
  const p0 = await dbg(() => window.__dbgPlayerPos());
  results.backUp = { zone: await dbg(() => window.__dbgZone().id), y: p0.y, deck: up?.y };
  check(results.backUp.zone === "overworld", "the console did not bring the hero back up");
  check(
    !!up && Math.hypot(p0.x - up.x, p0.z - up.z) < up.r && p0.y > up.y - 1,
    "the way up did not land on Cinderhelm's deck",
  );
  const before = await shards();
  const done = await talkTo("sky-gardener");
  const closed = await facts(Q4, [], ["knows-the-cities-built-it"]);
  const paid = (await shards()) - before;
  results.cinderhelm = { done, ...closed, paid };
  check(closed.status === "completed", `Pell's turn-in left Cinderhelm "${closed.status}"`);
  check(closed["knows-the-cities-built-it"] === true, "knows-the-cities-built-it was not set");
  check(paid === 160, `Cinderhelm paid ${paid}, not the promised 160`);
  // The shelf outlives its boss (#160): enterable, and nothing stands up.
  await tpDeck({ x: cinder.x + 20, y: cinder.y, z: cinder.z });
  const again = await isle("cinderhelm");
  const p1 = await dbg(() => window.__dbgPlayerPos());
  results.cinderReentry = { onDeck: p1.y > again.y - 1, cinderguards: (await enemies("cinderguard")).length };
  check(results.cinderReentry.onDeck, "Cinderhelm refused re-entry with the boss dead");
  check(results.cinderReentry.cinderguards === 0, "a Cinderguard stood up on the shelf with the quest closed");
}

// ---------- 4. the Orrery ---------------------------------------------------------
{
  const shelf = await shelfOf(Q5);
  check(shelf === "available", `The Orrery is on the "${shelf}" shelf with both arms done`);
  const offer = await talkTo("vess");
  check(offer !== null, "Vess has no offer");
  let s = await facts(Q5, ["reach-the-orrery"], []);
  check(s.status === "active", `Vess's offer left The Orrery "${s.status}"`);
  check(s["reach-the-orrery"] >= 1, "standing in the Orrery did not mark the arrival on activation");
  const orrery = await isle("orrery");
  await tpDeck({ x: orrery.x + 20, y: orrery.y, z: orrery.z });
  const guard = await until(async () => {
    const e = await enemies("choirguard");
    return e.length > 0 && e[0].targetable ? e[0] : null;
  });
  results.choirguard = guard;
  check(!!guard, "the Choirguard did not stand up in the Orrery");
  await dbg(() => window.__dbgKillEnemy("choirguard"));
  await adv(0.5);
  const before = await shards();
  const done = await talkTo("vess");
  const closed = await facts(Q5, ["defeat-choirguard", "hear-vess-out"], ["vess-truth", "act-3-complete"]);
  const paid = (await shards()) - before;
  results.orrery = { done, ...closed, paid };
  check(closed.status === "completed", `Vess's turn-in left The Orrery "${closed.status}"`);
  check(closed["hear-vess-out"] >= 1, "hear-vess-out was not marked");
  check(closed["vess-truth"] === true, "vess-truth was not set");
  check(closed["act-3-complete"] === true, "act-3-complete was not set");
  check(paid === 250, `The Orrery paid ${paid}, not the promised 250`);

  // The frame outlives its boss.
  await tpDeck({ x: orrery.x + 20, y: orrery.y, z: orrery.z });
  await adv(3);
  const again = await enemies("choirguard");
  const p = await dbg(() => window.__dbgPlayerPos());
  results.reentry = { choirguards: again.length, onDeck: p.y > orrery.y - 1 };
  check(again.length === 0, "the Choirguard respawned with the act closed");
  check(p.y > orrery.y - 1, "the Orrery refused re-entry");
}

console.log(JSON.stringify({ ...results, failures: fails, pass: fails.length === 0 }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
