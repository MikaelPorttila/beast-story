// ACT 3, QUEST 2 — WINGBROKEN (issue #158): the sky's tame quest, its mount
// tutorial, and the root of the act's fork.
//
// Usage: bun tools/test-wingbroken.mjs      (dev server must be up)
//
// Claims:
//
//   1. GAIN IS ALREADY UP HERE: his Skyhaven placement stands on the deck and
//      offers the quest once the ascent is closed, and not before.
//   2. PELL LETS YOU IN, AND THE BIRD APPEARS: her line marks the objective, and
//      only then does a wild Galebird stand in her garden — ON THE DECK, riding
//      the island, not on the ground under it.
//   3. THE BOND IS THE MOUNT: an orb bonds it, Gain closes the quest, and the
//      flying mount is unlocked while ground and water stay unlocked — all three.
//   4. THE FORK: with this quest complete, Lanternfall and Cinderhelm are each
//      on the shelf alone — neither waits on the other.
//
// Exits non-zero on failure.
import { launchBrowser, newPage, wait } from "./browser.mjs";
import { BASE as HOST, NO_WARMUP } from "./target.mjs";

const URL = `${HOST}/?menu=0&fs=0&vol=0&${NO_WARMUP}`;
const Q2 = "quest:sky/wingbroken";
const Q3 = "quest:sky/lanternfall";
const Q4 = "quest:sky/cinderhelm";

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
    const q = "quest:sky/wingbroken";
    return {
      status: content.state.questStatus(q),
      free: content.state.progress(q, "free-the-galebird"),
      tame: content.state.progress(q, "tame-galebird"),
      mountFlying: content.state.flag("mount-flying"),
    };
  });
const birds = () =>
  dbg(() => {
    const isle = window.__dbgCarriers().all[0];
    return window
      .__dbgBodies()
      .enemies.filter((e) => e.species === "wild-galebird")
      .map((e) => ({
        x: e.x,
        y: e.y,
        z: e.z,
        targetable: e.targetable,
        fromIsle: +Math.hypot(e.x - isle.x, e.z - isle.z).toFixed(1),
        overDeck: e.y - isle.y,
      }));
  });
const streamed = async () => {
  for (let i = 0; i < 80 && (await dbg(() => window.__dbgZone().streaming)); i++) {
    await wait(250);
  }
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

// ---------- 1. Gain on the deck, and the door ---------------------------------
{
  const gain = (await dbg(() => window.__dbgNpcs())).all.find((n) => n.id === "gain/skyhaven");
  results.gain = gain ? { town: gain.town, y: gain.y, ground: gain.ground } : null;
  check(!!gain, "npc:gain/skyhaven is not in the world");
  check(gain?.town === "skyhaven", `Gain's third placement stands in "${gain?.town}"`);
  check(gain && gain.y - gain.ground > 100, "Gain is not on the deck");

  for (const q of [
    "quest:land/the-mill-road",
    "quest:land/the-bellwether",
    "quest:sea/salt-and-rope",
    "quest:sea/dark-water",
    "quest:sea/the-drowned-market",
    "quest:sea/the-rookery",
    "quest:sea/what-the-tide-kept",
  ]) {
    await setQuest(q, "completed");
  }
  await adv(0.3);
  const early = await shelfOf(Q2);
  check(early !== "available", `Wingbroken is offered before the ascent (shelf "${early}")`);
  await setQuest("quest:sky/the-long-ascent", "completed");
  await adv(0.3);
  const shelf = await shelfOf(Q2);
  results.shelf = { early, shelf };
  check(shelf === "available", `Wingbroken is on the "${shelf}" shelf, not "available"`);

  const offer = await talkTo("gain/skyhaven");
  await adv(0.3);
  const s = await state();
  results.offer = { line: offer, ...s };
  check(offer !== null, "Gain has no offer on the deck");
  check(s.status === "active", `the offer left Wingbroken "${s.status}"`);
}

// ---------- 2. Pell lets you in, and the bird appears -------------------------
{
  await adv(2);
  const before = await birds();
  check(before.length === 0, `a Galebird stands in the garden before Pell allowed it (${before.length})`);
  const allow = await talkTo("sky-gardener");
  await adv(0.3);
  const s = await state();
  check(allow !== null, "Mother Pell has no line");
  check(s.free >= 1, "Pell's line did not mark free-the-galebird");
  let staged = [];
  for (let i = 0; i < 20 && !staged.some((b) => b.targetable); i++) {
    await adv(0.5);
    staged = await birds();
  }
  results.bird = { allow, staged };
  check(staged.length === 1, `${staged.length} Galebirds in the garden, want 1`);
  const bird = staged[0];
  check(bird && bird.fromIsle < 90, `the bird is ${bird?.fromIsle} from the island's centre`);
  check(bird && bird.overDeck > -2 && bird.overDeck < 12, `the bird hangs ${bird?.overDeck} over the deck`);
  // And it RIDES: the island moves, the bird keeps its place on it.
  const a = (await dbg(() => window.__dbgCarriers())).all[0];
  await adv(4);
  const b = (await dbg(() => window.__dbgCarriers())).all[0];
  const later = (await birds())[0];
  const moved = Math.hypot(b.x - a.x, b.z - a.z);
  results.ride = { islandMoved: +moved.toFixed(2), fromIsle: later?.fromIsle, overDeck: later?.overDeck };
  check(later && later.overDeck > -2, `the bird fell off the island (${later?.overDeck} over the deck)`);
}

// ---------- 3. the bond is the mount --------------------------------------------
const bird = (await birds())[0];
if (bird) {
  await dbg((b) => window.__dbgTp(b.x + 3, b.z + 3, b.y + 0.3), bird);
  await adv(0.5);
  await dbg(() => window.__dbgGive("orb-tame", 3));
  results.throwSaid = await dbg(() => window.__dbgThrowOrb("wild-galebird", true));
  let landed = false;
  for (let i = 0; i < 40 && !landed; i++) {
    await adv(0.1);
    landed = (await dbg(() => window.__dbgTaming())).bonding;
  }
  check(landed, `the orb never reached the Galebird (${results.throwSaid?.dist} units out)`);
  for (let i = 0; i < 80 && (await dbg(() => window.__dbgTaming())).bonding; i++) {
    await adv(0.1);
  }
  await wait(300);
  const tamed = await state();
  check(tamed.tame >= 1, "the bond did not mark tame-galebird");
  await adv(2);
  results.afterBond = await birds();
  check(results.afterBond.length === 0, "the garden restocked after the bond");

  const before = await dbg(() => window.__dbgZone().shards);
  const done = await talkTo("gain/skyhaven");
  await wait(250);
  const closed = await state();
  const paid = (await dbg(() => window.__dbgZone().shards)) - before;
  const mounts = await dbg(() => window.__dbgMount().unlocked);
  results.closed = { line: done, ...closed, paid, mounts };
  check(closed.status === "completed", `the turn-in left Wingbroken "${closed.status}"`);
  check(closed.mountFlying === true, "mount-flying was not set");
  check(paid === 120, `Wingbroken paid ${paid} shards, not the promised 120`);
  for (const kind of ["ground", "water", "flying"]) {
    check(mounts.includes(kind), `${kind} is not unlocked after Wingbroken: ${JSON.stringify(mounts)}`);
  }
} else {
  check(false, "no Galebird to bond — the stage stood none up");
}

// ---------- 4. the fork ------------------------------------------------------------
{
  await adv(0.3);
  const shelves = { q3: await shelfOf(Q3), q4: await shelfOf(Q4) };
  results.fork = shelves;
  check(shelves.q3 === "available", `Lanternfall is on the "${shelves.q3}" shelf with Wingbroken done`);
  check(shelves.q4 === "available", `Cinderhelm is on the "${shelves.q4}" shelf with Wingbroken done`);
}

console.log(JSON.stringify({ ...results, failures: fails, pass: fails.length === 0 }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
