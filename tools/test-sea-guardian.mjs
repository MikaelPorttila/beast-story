// ACT 4, QUEST 3 — THE SEA GUARDIAN (issue #164): the water road, given by
// Coil from Kelphold's quay and fought under the ring at Maw's Rest.
//
// Usage: bun tools/test-sea-guardian.mjs      (dev server must be up)
//
// Claims:
//
//   1. THE GATE, BOTH HALVES: with Three Roads closed and `mount-water`
//      unset the quest is not shelved and Coil refuses it; with the flag set
//      she offers and it starts. The flag, never the mount system.
//   2. THE STAGE: within reach of the ring the arrival is marked and the
//      guardian rises — a `bond: water` swimmer with `behaviour: guardian` —
//      UNDER the surface and over the bed, in the Brineholder's own ring, and
//      still so after seconds of its own steering.
//   3. THE BOND, BOTH HALVES, MEASURED: sword blows from a swimmer leave its
//      hp at max; the same blows from the saddle of a water mount take hp off.
//   4. THE CLOSE: killed, Coil closes it — guardian-sea-freed, 200 paid — her
//      fire placement says so, and the ring rises nobody again.
//
// Exits non-zero on failure.
import { launchBrowser, newPage, wait } from "./browser.mjs";
import { BASE as HOST, NO_WARMUP } from "./target.mjs";

const URL = `${HOST}/?menu=0&fs=0&vol=0&debug=1&${NO_WARMUP}`;
const Q2 = "quest:seam/guardian-sea";
const GUARDIAN = "guardian/sea";
/** A water beast; the same one test-deepwater rides. */
const WATER_MOUNT = "finnick";
/** The game's WATER_LEVEL (world/terrain.ts). */
const WATER_LEVEL = 8;

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

// ---------- stage: Three Roads closed, no water mount ----------------------------
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
  // The gate is the FLAG. Dark Water set it in Act 2; take it back for the first half.
  content.run([{ do: "flag.clear", flag: "mount-water" }]);
});
await adv(0.3);


// ---------- 1. the gate, both halves --------------------------------------------
{
  const without = { shelf: await shelfOf(Q2), line: await talkTo("coil/kelphold") };
  without.status = (await facts(Q2, [], [])).status;
  check(without.shelf !== "available", `the sea road is on the "${without.shelf}" shelf without mount-water`);
  check(without.status !== "active", `Coil started the sea road without mount-water ("${without.status}")`);
  check(
    without.line !== null && !without.line.includes("stay in the saddle"),
    "Coil offered the sea road without the water mount",
  );

  await run([{ do: "flag.set", flag: "mount-water" }]);
  await adv(0.2);
  const withFlag = { shelf: await shelfOf(Q2), line: await talkTo("coil/kelphold") };
  withFlag.status = (await facts(Q2, [], [])).status;
  results.gate = { without, withFlag };
  check(withFlag.status === "active", `Coil's offer left the sea road "${withFlag.status}"`);
}

// ---------- 2. the stage -------------------------------------------------------------
{
  const site = (await dbg(() => window.__dbgQuestSites())).mawsRest;
  check(!!site, "no ring at Maw's Rest to stage on");
  // A swimmer on foot in the ring's water: no mount, and the ring is not the dark kind.
  await dbg(() => window.__dbgRide("off"));
  await dbg((p) => window.__dbgTp(p.x - 8, p.z), site);
  await streamed();
  const g = await until(async () => {
    const e = await guardian();
    return e && e.targetable ? e : null;
  });
  const s = await facts(Q2, ["reach-maws-rest"], []);
  // WET: under the surface and over the bed, and still so after seconds of its own steering.
  await adv(3);
  const later = await guardian();
  const bed = later ? await dbg((p) => window.__dbgSurfaceY(p.x, p.z).ground, later) : null;
  results.stage = { site, guardian: g, later, bed, ...s };
  check(!!g, "the Sea Guardian did not rise in the ring");
  check(s["reach-maws-rest"] >= 1, "reaching the ring was not marked");
  check(g && Math.hypot(g.x - site.x, g.z - site.z) < 30, "the guardian rose somewhere else");
  check(
    later !== null && later.y < WATER_LEVEL - 0.5 && later.y > bed,
    `the guardian is not swimming: y ${later?.y}, bed ${bed}, surface ${WATER_LEVEL}`,
  );
}

// ---------- 3. the bond, both halves, measured ------------------------------------
{
  await dbg(() => window.__dbgRide("off"));
  const swimming = await blows();
  const mounted0 = await dbg(() => window.__dbgUnlockMount("water", true));
  await dbg((sp) => window.__dbgGrantBeast(sp), WATER_MOUNT);
  // A swimmer cannot mount mid-water (the game's own rule): saddle up on Kelphold's
  // quay and ride back out — a teleport carries mount and rider together.
  const site = (await dbg(() => window.__dbgQuestSites())).mawsRest;
  const quay = await dbg(() => {
    const t = window.__dbgTowns().structures.perTown.find((x) => x.id === "kelphold");
    return { x: t.x, z: t.z };
  });
  await dbg((p) => window.__dbgTp(p.x, p.z), quay);
  await streamed();
  await adv(0.6);
  const said = await dbg((sp) => window.__dbgRide(sp), WATER_MOUNT);
  await dbg((p) => window.__dbgTp(p.x - 8, p.z), site);
  await streamed();
  await adv(0.5);
  const riding = await dbg(() => window.__dbgMount());
  const inSaddle = await blows();
  await dbg(() => window.__dbgRide("off"));
  results.bond = { swimming, said, riding, inSaddle, mounted0 };
  check(
    swimming.before !== null && swimming.after === swimming.before,
    `swimming, the guardian went ${swimming.before} -> ${swimming.after}: it should not answer`,
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
  const done = await talkTo("coil/kelphold");
  const closed = await facts(Q2, [], ["guardian-sea-freed"]);
  const paid = (await shards()) - before;
  const fire = await talkTo("coil/encampment");
  results.close = { done, ...closed, paid, fire };
  check(closed.status === "completed", `Coil's turn-in left the sea road "${closed.status}"`);
  check(closed["guardian-sea-freed"] === true, "guardian-sea-freed was not set");
  check(paid === 200, `the sea road paid ${paid}, not the promised 200`);
  check(fire?.includes("felt it from the quay"), "Coil at the fire did not notice the thread go slack");

  // The ring outlives its guardian: nothing rises again.
  const site = (await dbg(() => window.__dbgQuestSites())).mawsRest;
  await dbg((p) => window.__dbgTp(p.x - 8, p.z), site);
  await streamed();
  await adv(3);
  const again = await guardian();
  results.reentry = { guardian: again };
  check(again === null, "the guardian rose again with its road closed");
}

console.log(JSON.stringify({ ...results, failures: fails, pass: fails.length === 0 }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
