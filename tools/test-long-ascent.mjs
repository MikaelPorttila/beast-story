// ACT 3, QUEST 1 — THE LONG ASCENT (issue #157): the balloon, both ways, and the
// Act 2 -> Act 3 seam played through rather than staged.
//
// Usage: bun tools/test-long-ascent.mjs      (dev server must be up)
//
// Claims:
//
//   1. THE BALLOON MOORS ON THE FLAG: no craft before sky-revealed, two after —
//      one at Corwin Vane's wreck on Gullspire, one on Skyhaven's deck — and the
//      quest is on the "available" shelf only after the act's closer.
//   2. THE WRECK IS THE DOOR: Vane's Gullspire placement offers the ascent, and
//      the offer marks nothing — boarding is the balloon's own fact.
//   3. UP: a press on the wreck pad lands the hero on the island's mooring, at
//      altitude, with `board-the-balloon` AND `reach-skyhaven` marked; Vane's
//      Skyhaven placement closes it — act-3-open, the town discovered, 100 paid.
//   4. DOWN: the same pad, walked off and back onto, rides to the wreck — the
//      seam is a return, and Act 4 needs it.
//
// Exits non-zero on failure.
import { launchBrowser, newPage, wait } from "./browser.mjs";
import { BASE as HOST, NO_WARMUP } from "./target.mjs";

const URL = `${HOST}/?menu=0&fs=0&vol=0&${NO_WARMUP}`;
const Q1 = "quest:sky/the-long-ascent";

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
const balloon = () => dbg(() => window.__dbgBalloon());
const shelfOf = (id) =>
  dbg((q) => window.__dbgJournal().model.find((e) => e.id === q)?.tab ?? null, id);
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
const streamed = async () => {
  for (let i = 0; i < 80 && (await dbg(() => window.__dbgZone().streaming)); i++) {
    await wait(250);
  }
};

async function talkTo(id) {
  // Stand on the target's far side from whoever is next to him, and away from the
  // town's middle — the crew stand close on a deck, E talks to the NEAREST, and the
  // middle of a carried town is a building. Re-read each try: the deck moves.
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

/** Stand on a pad, press, and wait the ride out. Returns where the hero ended. */
async function ride(pad) {
  await dbg((p) => window.__dbgTp(p.x, p.z, p.y > 100 ? p.y + 0.3 : undefined), pad);
  await streamed();
  await wait(400);
  const armed = await balloon();
  await page.keyboard.press("KeyE");
  await wait(200);
  const started = (await balloon()).sailing;
  for (let i = 0; i < 80 && (await balloon()).sailing !== null; i++) {
    await wait(250);
  }
  await wait(300);
  const p = await dbg(() => window.__dbgPlayerPos());
  return { engaged: armed.engaged, started, p };
}

// ---------- 1. moored on the flag --------------------------------------------
{
  const before = await balloon();
  const shelf = await shelfOf(Q1);
  results.before = { enabled: before.enabled, shelf };
  check(before.present, "the balloon was not built — is Gullspire or Skyhaven's mooring missing?");
  check(before.enabled === false, "the balloon is moored before sky-revealed");
  check(shelf !== "available", `the ascent is offered before the act's closer (shelf "${shelf}")`);

  await dbg(async () => {
    const { content } = await import("/src/content/index.ts");
    for (const q of [
      "quest:land/the-bellwether",
      "quest:sea/salt-and-rope",
      "quest:sea/dark-water",
      "quest:sea/the-drowned-market",
      "quest:sea/the-rookery",
      "quest:sea/what-the-tide-kept",
    ]) {
      content.state.setQuestStatus(q, "completed");
    }
  });
  await adv(0.5);
  const after = await balloon();
  results.moored = after;
  check(after.enabled === true, "sky-revealed did not moor the balloon");
  check(after.stops.every((s) => s.boatVisible), "a balloon is missing from its pad");
  const top = after.stops.find((s) => s.id === "skyhaven-mooring");
  const bottom = after.stops.find((s) => s.id === "vane-wreck");
  check(!!top && !!bottom, "the two moorings are not the wreck and the island");
  check(top && top.y > 150, `Skyhaven's mooring is at y=${top?.y}, not at altitude`);
  check((await shelfOf(Q1)) === "available", "the ascent is not on the available shelf");
}

// ---------- 2. the wreck is the door -----------------------------------------
{
  const line = await talkTo("sky-pilot/gullspire");
  await adv(0.3);
  const s = await sky();
  results.offer = { line, ...s };
  check(line !== null, "Vane at the wreck has no line");
  check(s.status === "active", `the wreck's offer left the ascent "${s.status}"`);
  check(s.board === 0, "the offer marked boarding — that is the balloon's fact, not a line's");
}

// ---------- 3. up ---------------------------------------------------------------
{
  const pads = (await balloon()).stops;
  const wreck = pads.find((s) => s.id === "vane-wreck");
  const up = await ride(wreck);
  const top = (await balloon()).stops.find((s) => s.id === "skyhaven-mooring");
  const d = Math.hypot(up.p.x - top.x, up.p.z - top.z);
  const s = await sky();
  const before = await dbg(() => window.__dbgZone().shards);
  results.up = { ...up, d: +d.toFixed(1), top, ...s };
  check(up.engaged === "vane-wreck", `standing on the wreck pad engaged "${up.engaged}"`);
  check(up.started !== null, "the press did not start the ride");
  check(d < 6, `the ride landed ${d.toFixed(1)} from Skyhaven's mooring`);
  check(up.p.y > 150, `the hero landed at y=${up.p.y}, not on the deck`);
  check(s.board >= 1, "boarding was not marked by the ride");
  check(s.reach >= 1, "landing on the deck did not mark reach-skyhaven");

  const done = await talkTo("sky-pilot");
  await wait(250);
  const closed = await sky();
  const paid = (await dbg(() => window.__dbgZone().shards)) - before;
  results.closed = { line: done, ...closed, paid };
  check(done !== null, "Vane on the deck has no line");
  check(closed.status === "completed", `the turn-in left the ascent "${closed.status}"`);
  check(closed.act3 === true, "act-3-open was not set");
  check(closed.discovered === true, "town:skyhaven was not discovered");
  check(paid === 100, `the ascent paid ${paid} shards, not the promised 100`);
}

// ---------- 4. down -------------------------------------------------------------
{
  const top = (await balloon()).stops.find((s) => s.id === "skyhaven-mooring");
  const down = await ride(top);
  const wreck = (await balloon()).stops.find((s) => s.id === "vane-wreck");
  const d = Math.hypot(down.p.x - wreck.x, down.p.z - wreck.z);
  results.down = { ...down, d: +d.toFixed(1) };
  check(down.engaged === "skyhaven-mooring", `the mooring pad engaged "${down.engaged}"`);
  check(d < 6, `the descent landed ${d.toFixed(1)} from the wreck`);
  check(down.p.y < 60, `the hero is still at y=${down.p.y} after the descent`);
}

console.log(JSON.stringify({ ...results, failures: fails, pass: fails.length === 0 }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
