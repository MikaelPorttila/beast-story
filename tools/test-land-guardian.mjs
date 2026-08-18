// ACT 4, QUEST 2 — THE LAND GUARDIAN (issue #163): the ground road, and the
// act's mechanical thesis — the mount is not optional.
//
// Usage: bun tools/test-land-guardian.mjs      (dev server must be up)
//
// Claims:
//
//   1. THE GATE, BOTH HALVES: with Three Roads closed and `mount-ground`
//      unset the quest is not shelved and Gain refuses it; with the flag set
//      it is offered and started. The flag, never the mount system.
//   2. THE STAGE: within reach of the drove ground the arrival is marked and
//      the guardian stands up — a `bond: ground` walker with `behaviour:
//      guardian` — and it is Stonewatch's own drove ground, the Bellwether's.
//   3. THE BOND, BOTH HALVES, MEASURED: sword blows on foot leave its hp at
//      max; the same blows from the saddle of a ground mount take hp off it.
//   4. THE CLOSE: killed, Gain closes it — guardian-land-freed, 200 paid —
//      Tobin at the fire says so, and the drove ground stands nobody up again.
//
// Exits non-zero on failure.
import { launchBrowser, newPage, wait } from "./browser.mjs";
import { BASE as HOST, NO_WARMUP } from "./target.mjs";

const URL = `${HOST}/?menu=0&fs=0&vol=0&debug=1&${NO_WARMUP}`;
const Q2 = "quest:seam/guardian-land";
const GUARDIAN = "guardian/land";
/** A ground beast; the same one test-deepwater rides. */
const GROUND_MOUNT = "boulderpup";

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
    await dbg((n, ox, oz) => window.__dbgTp(n.x + ox, n.z + oz), who, Math.sin(a) * 1.7, Math.cos(a) * 1.7);
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
    await dbg((x, z) => window.__dbgTp(x, z), g.x + Math.sin(ang) * d, g.z + Math.cos(ang) * d);
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

// ---------- stage: Three Roads closed, no ground mount ---------------------------
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
  // The gate is the FLAG. The mill road set it in Act 1; take it back for the first half.
  content.run([{ do: "flag.clear", flag: "mount-ground" }]);
});
await adv(0.3);

// ---------- 1. the gate, both halves --------------------------------------------
{
  await dbg(() => {
    const s = window.__dbgTowns().spawn;
    window.__dbgTp(s.x, s.z);
  });
  await streamed();
  const without = { shelf: await shelfOf(Q2), line: await talkTo("gain") };
  without.status = (await facts(Q2, [], [])).status;
  check(without.shelf !== "available", `the land road is on the "${without.shelf}" shelf without mount-ground`);
  check(without.status !== "active", `Gain started the land road without mount-ground ("${without.status}")`);
  check(
    without.line !== null && !without.line.includes("drove ground, where the Bellwether"),
    "Gain offered the land road without the ground mount",
  );

  await run([{ do: "flag.set", flag: "mount-ground" }]);
  await adv(0.2);
  const withFlag = { shelf: await shelfOf(Q2), line: await talkTo("gain") };
  withFlag.status = (await facts(Q2, [], [])).status;
  results.gate = { without, withFlag };
  check(withFlag.shelf === "available" || withFlag.status === "active", `the land road is on the "${withFlag.shelf}" shelf with mount-ground`);
  check(withFlag.status === "active", `Gain's offer left the land road "${withFlag.status}"`);
}

// ---------- 2. the stage -------------------------------------------------------------
{
  const site = (await dbg(() => window.__dbgQuestSites())).droveGround;
  check(!!site, "no drove ground to stage on");
  await dbg((p) => window.__dbgTp(p.x + 12, p.z), site);
  await streamed();
  const g = await until(async () => {
    const e = await guardian();
    return e && e.targetable ? e : null;
  });
  const s = await facts(Q2, ["reach-the-drove-ground"], []);
  results.stage = { site, guardian: g, ...s };
  check(!!g, "the Land Guardian did not stand up on the drove ground");
  check(s["reach-the-drove-ground"] >= 1, "reaching the drove ground was not marked");
  check(g && Math.hypot(g.x - site.x, g.z - site.z) < 30, "the guardian stood up somewhere else");
}

// ---------- 3. the bond, both halves, measured ------------------------------------
{
  await dbg(() => window.__dbgRide("off"));
  const onFoot = await blows();
  const mounted0 = await dbg(() => window.__dbgUnlockMount("ground", true));
  await dbg((sp) => window.__dbgGrantBeast(sp), GROUND_MOUNT);
  const said = await dbg((sp) => window.__dbgRide(sp), GROUND_MOUNT);
  await adv(0.5);
  const riding = await dbg(() => window.__dbgMount());
  const inSaddle = await blows();
  await dbg(() => window.__dbgRide("off"));
  results.bond = { onFoot, said, riding, inSaddle, mounted0 };
  check(onFoot.before !== null && onFoot.after === onFoot.before, `on foot the guardian went ${onFoot.before} -> ${onFoot.after}: it should not answer`);
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
  let s = await facts(Q2, ["free-the-guardian"], []);
  check(s["free-the-guardian"] >= 1, "the kill did not count");
  await dbg(() => {
    const t = window.__dbgTowns().spawn;
    window.__dbgTp(t.x, t.z);
  });
  await streamed();
  const before = await shards();
  const done = await talkTo("gain");
  const closed = await facts(Q2, [], ["guardian-land-freed"]);
  const paid = (await shards()) - before;
  const tobin = await talkTo("sky-lamplighter/encampment");
  results.close = { done, ...closed, paid, tobin };
  check(closed.status === "completed", `Gain's turn-in left the land road "${closed.status}"`);
  check(closed["guardian-land-freed"] === true, "guardian-land-freed was not set");
  check(paid === 200, `the land road paid ${paid}, not the promised 200`);
  check(tobin?.includes("drove ground went quiet"), "Tobin at the fire did not notice the thread go slack");

  // The ground outlives its guardian: nothing stands up again.
  const site = (await dbg(() => window.__dbgQuestSites())).droveGround;
  await dbg((p) => window.__dbgTp(p.x + 12, p.z), site);
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
