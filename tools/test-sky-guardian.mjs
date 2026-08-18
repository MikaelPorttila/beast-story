// ACT 4, QUEST 4 — THE SKY GUARDIAN (issue #165): the air road, given by
// Mother Pell from her garden on Skyhaven and fought over the Orrery's frame.
//
// Usage: bun tools/test-sky-guardian.mjs      (dev server must be up)
//
// Claims:
//
//   1. THE GATE, BOTH HALVES: with Three Roads closed and `mount-flying`
//      unset the quest is not shelved and Pell refuses it; with the flag set
//      she offers and it starts. The flag, never the mount system.
//   2. THE STAGE: on the Orrery's deck the arrival is marked and the guardian
//      stands up IN THE AIR — a `bond: flying` hoverer with `behaviour:
//      guardian` — a body-and-a-half over the deck, still so after seconds
//      of its own steering, and over the island (which cruises).
//   3. THE BOND, BOTH HALVES, MEASURED: sword blows from the deck leave its
//      hp at max; the same blows from the saddle of a flying mount, at its
//      altitude, take hp off it.
//   4. THE CLOSE: killed, Pell closes it — guardian-sky-freed, 200 paid — her
//      fire placement says so, and the frame stands nobody up again.
//
// Exits non-zero on failure.
import { launchBrowser, newPage, wait } from "./browser.mjs";
import { BASE as HOST, NO_WARMUP } from "./target.mjs";

const URL = `${HOST}/?menu=0&fs=0&vol=0&debug=1&${NO_WARMUP}`;
const Q2 = "quest:seam/guardian-sky";
const GUARDIAN = "guardian/sky";
/** A flyer; the same one test-carrier rides. */
const FLYING_MOUNT = "galebird";

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
const run = (actions) =>
  dbg(async (a) => {
    const { content } = await import("/src/content/index.ts");
    content.run(a);
  }, actions);
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
const guardian = () =>
  dbg((sp) => window.__dbgBodies().enemies.find((e) => e.species === sp && !e.isDead) ?? null, GUARDIAN);
const streamed = async () => {
  for (let i = 0; i < 80 && (await dbg(() => window.__dbgZone().streaming)); i++) {
    await wait(250);
  }
};
const until = async (fn, tries = 24, step = 0.5) => {
  let v = null;
  for (let i = 0; i < tries && !v; i++) {
    await adv(step);
    v = await fn();
  }
  return v;
};

/** Stand within talk range of `id` and press E; the fire is a crowd (see test-three-roads). */
async function talkTo(id) {
  for (let k = 0; k < 8; k++) {
    const who = (await dbg(() => window.__dbgNpcs())).all.find((n) => n.id === id);
    if (!who) {
      return null;
    }
    const a = (k / 8) * Math.PI * 2;
    // On a DECK the teleport carries the height (a bare x, z lands on the country under the island).
    await dbg(
      (n, ox, oz) => window.__dbgTp(n.x + ox, n.z + oz, n.y - n.ground > 3 ? n.y + 0.3 : undefined),
      who,
      Math.sin(a) * 1.7,
      Math.cos(a) * 1.7,
    );
    await streamed();
    await adv(0.3);
    const near = (await dbg(() => window.__dbgNpcs())).all.find((n) => n.inTalkRange)?.id;
    if (near !== id) {
      continue;
    }
    await page.keyboard.press("KeyE");
    await wait(250);
    const talking = (await dbg(() => window.__dbgNpcs())).talking;
    if (talking) {
      await page.keyboard.press("Escape");
      await wait(200);
    }
    if (talking?.id === id) {
      return talking.line;
    }
  }
  return null;
}

/**
 * Six sword blows at the guardian: stand a stride short of its flank, aim the
 * lens at it, press. Re-stood before each blow — it circles. Returns hp before
 * and after, so the caller asserts the DELTA, which is what a bond gates.
 */
async function blows() {
  const before = (await guardian())?.hp ?? null;
  for (let i = 0; i < 6; i++) {
    const g = await guardian();
    if (!g) {
      break;
    }
    const p = await dbg(() => window.__dbgPlayerPos());
    const ang = Math.atan2(p.x - g.x, p.z - g.z);
    const d = g.radius + 0.9;
    // At ITS altitude when riding a flyer; a walker's teleport lands on the deck under it.
    const flying = await dbg(() => window.__dbgMount().mounted);
    await dbg(
      (x, z, y) => window.__dbgTp(x, z, y),
      g.x + Math.sin(ang) * d,
      g.z + Math.cos(ang) * d,
      flying ? g.y - 0.6 : undefined,
    );
    await adv(0.2);
    await dbg((b) => window.__dbgAim(b), Math.atan2(g.x - (g.x + Math.sin(ang) * d), g.z - (g.z + Math.cos(ang) * d)));
    await adv(0.1);
    await page.mouse.down();
    await dbg(() => 0);
    await adv(0.07);
    await page.mouse.up();
    await adv(0.5);
  }
  const after = (await guardian())?.hp ?? null;
  return { before, after };
}

// ---------- stage: Three Roads closed, no flying mount ---------------------------
await dbg(async () => {
  const { content } = await import("/src/content/index.ts");
  for (const q of [
    "quest:land/first-light",
    "quest:land/the-blue-road",
    "quest:land/the-first-bond",
    "quest:land/the-mill-road",
    "quest:land/the-red-thread",
    "quest:land/the-bellwether",
    "quest:sea/salt-and-rope",
    "quest:sea/dark-water",
    "quest:sea/the-drowned-market",
    "quest:sea/the-rookery",
    "quest:sea/what-the-tide-kept",
    "quest:sky/the-long-ascent",
    "quest:sky/wingbroken",
    "quest:sky/lanternfall",
    "quest:sky/cinderhelm",
    "quest:sky/the-orrery",
  ]) {
    content.state.setQuestStatus(q, "completed");
  }
});
// The seam package lands async; wait for its quest to be known.
for (let i = 0; i < 40 && !(await dbg(() => window.__dbgContent().packages.some((p) => p.id === "story-seam"))); i++) {
  await wait(250);
}
await dbg(async () => {
  const { content } = await import("/src/content/index.ts");
  content.state.setQuestStatus("quest:seam/three-roads", "completed");
  // The gate is the FLAG. Wingbroken set it in Act 3; take it back for the first half.
  content.run([{ do: "flag.clear", flag: "mount-flying" }]);
});
await adv(0.3);


// ---------- 1. the gate, both halves --------------------------------------------
{
  const without = { shelf: await shelfOf(Q2), line: await talkTo("sky-gardener") };
  without.status = (await facts(Q2, [], [])).status;
  check(without.shelf !== "available", `the sky road is on the "${without.shelf}" shelf without mount-flying`);
  check(without.status !== "active", `Pell started the sky road without mount-flying ("${without.status}")`);
  check(
    without.line !== null && !without.line.includes("stay on the wing"),
    "Pell offered the sky road without the flying mount",
  );

  await run([{ do: "flag.set", flag: "mount-flying" }]);
  await adv(0.2);
  const withFlag = { shelf: await shelfOf(Q2), line: await talkTo("sky-gardener") };
  withFlag.status = (await facts(Q2, [], [])).status;
  results.gate = { without, withFlag };
  check(withFlag.status === "active", `Pell's offer left the sky road "${withFlag.status}"`);
}

const isle = (town) =>
  dbg((t) => {
    const k = window.__dbgCarriers().all.find((c) => c.id === `carrier:town:${t}`);
    return k ? { x: k.x, y: k.y, z: k.z, r: k.radius } : null;
  }, town);

// ---------- 2. the stage -------------------------------------------------------------
{
  await dbg(() => window.__dbgRide("off"));
  const o = await isle("orrery");
  check(!!o, "no Orrery to stage on");
  await dbg((p) => window.__dbgTp(p.x + 18, p.z, p.y + 0.3), o);
  await streamed();
  await adv(0.5);
  const g = await until(async () => {
    const e = await guardian();
    return e && e.targetable ? e : null;
  });
  const s = await facts(Q2, ["reach-the-orrery"], []);
  // IN THE AIR, over the deck, riding the island: re-read the island, it cruises.
  await adv(3);
  const later = await guardian();
  const now = await isle("orrery");
  results.stage = { isle: o, guardian: g, later, now, ...s };
  check(!!g, "the Sky Guardian did not stand up over the Orrery");
  check(s["reach-the-orrery"] >= 1, "reaching the Orrery was not marked");
  check(
    later !== null && now !== null && Math.hypot(later.x - now.x, later.z - now.z) < now.r,
    "the guardian is not over the Orrery's deck",
  );
  check(
    later !== null && now !== null && later.y > now.y + 2.5 && later.y < now.y + 6,
    `the guardian is not hovering a body-and-a-half over the deck: y ${later?.y}, deck ${now?.y}`,
  );
}

// ---------- 3. the bond, both halves, measured ------------------------------------
{
  await dbg(() => window.__dbgRide("off"));
  const onDeck = await blows();
  const mounted0 = await dbg(() => window.__dbgUnlockMount("flying", true));
  await dbg((sp) => window.__dbgGrantBeast(sp), FLYING_MOUNT);
  const said = await dbg((sp) => window.__dbgRide(sp), FLYING_MOUNT);
  await adv(0.5);
  const riding = await dbg(() => window.__dbgMount());
  const inSaddle = await blows();
  await dbg(() => window.__dbgRide("off"));
  results.bond = { onDeck, said, riding, inSaddle, mounted0 };
  check(
    onDeck.before !== null && onDeck.after === onDeck.before,
    `from the deck the guardian went ${onDeck.before} -> ${onDeck.after}: it should not answer`,
  );
  check(riding?.mounted === true, `the hero is not riding: ${JSON.stringify(riding)}`);
  check(
    inSaddle.before !== null && inSaddle.after !== null && inSaddle.after < inSaddle.before,
    `from the saddle the guardian went ${inSaddle.before} -> ${inSaddle.after}: the bond did not answer the mount`,
  );
}

// ---------- 4. the close --------------------------------------------------------------
{
  await dbg((sp) => window.__dbgKillEnemy(sp), GUARDIAN);
  await adv(0.5);
  const s = await facts(Q2, ["free-the-guardian"], []);
  check(s["free-the-guardian"] >= 1, "the kill did not count");
  const before = await shards();
  const done = await talkTo("sky-gardener");
  const closed = await facts(Q2, [], ["guardian-sky-freed"]);
  const paid = (await shards()) - before;
  const fire = await talkTo("sky-gardener/encampment");
  results.close = { done, ...closed, paid, fire };
  check(closed.status === "completed", `Pell's turn-in left the sky road "${closed.status}"`);
  check(closed["guardian-sky-freed"] === true, "guardian-sky-freed was not set");
  check(paid === 200, `the sky road paid ${paid}, not the promised 200`);
  check(fire?.includes("frame is quiet"), "Pell at the fire did not notice the thread go slack");

  // The frame outlives its guardian: nothing stands up again.
  const o = await isle("orrery");
  await dbg((p) => window.__dbgTp(p.x + 18, p.z, p.y + 0.3), o);
  await streamed();
  await adv(3);
  const again = await guardian();
  results.reentry = { guardian: again };
  check(again === null, "the guardian stood up again with its road closed");
}

console.log(JSON.stringify({ ...results, failures: fails, pass: fails.length === 0 }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
