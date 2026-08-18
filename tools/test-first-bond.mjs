// ACT 4, QUEST 5 — THE FIRST BOND (issue #166): the campaign's terminal seam.
// The arch the player OPENS, the Seam, Rhune across three phases, the decision,
// and exactly one ending flag.
//
// Usage: bun tools/test-first-bond.mjs      (dev server must be up)
//
// Claims:
//
//   1. THE ARCH, BOTH HALVES: with two threads slack the Seam's arch outside
//      the Encampment is SHUT — no light, a shut hint, a press does nothing —
//      and Pell at the fire does not offer; with the third slack it opens, the
//      toast says so, Pell offers, and the press crosses into `seam`.
//   2. THE SEAM: arriving marks open-the-seam; Rhune stands up on the meadow,
//      `bond: ground`; hurt to 60% it changes to water and is moved into the
//      tide; to 30% it changes to flying and is moved over the cloud deck —
//      one fight, three mounts. Killed, defeat-rhune counts.
//   3. THE DECISION: E at the engine opens the choice panel with three
//      answers; picking one sets ITS ending flag and no other, and `decide`
//      counts. `ending.set` applied again swaps the flag — never two, never
//      none.
//   4. THE CLOSE: back at the fire Pell closes it — act-4-complete, 500 paid
//      — and every act's flag is set in turn: act-1 .. act-4, plus exactly one
//      ending. Gain's epilogue reads the ending flag.
//
// Exits non-zero on failure.
import { launchBrowser, newPage, wait } from "./browser.mjs";
import { BASE as HOST, NO_WARMUP } from "./target.mjs";

// No `fps=`: the crossing waits on a world being built.
const URL = `${HOST}/?menu=0&fs=0&vol=0&debug=1&${NO_WARMUP}`;
const Q5 = "quest:seam/the-first-bond";
const BOSS = "rhune";
const CROSS_TIMEOUT = 60000;

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
const flags = (fs) => facts(Q5, [], fs);
const shards = () => dbg(() => window.__dbgZone().shards);
const zone = () => dbg(() => window.__dbgZone());
const hint = () => dbg(() => document.querySelector(".bs-hint")?.textContent ?? null);
const boss = () =>
  dbg((sp) => window.__dbgBodies().enemies.find((e) => e.species === sp && !e.isDead) ?? null, BOSS);
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
const ENDINGS = ["ending-severed", "ending-held", "ending-shared"];
const oneEnding = (f) => ENDINGS.filter((e) => f[e] === true).length;

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

async function pressAndCross(from) {
  const t0 = Date.now();
  await page.keyboard.press("KeyE");
  for (let i = 0; i < CROSS_TIMEOUT / 250; i++) {
    await wait(250);
    if ((await zone()).id !== from) {
      return Date.now() - t0;
    }
  }
  return null;
}

/** One console line, the way test-orrery drives it. */
async function cmd(line) {
  await page.keyboard.press("Backquote");
  await page.waitForSelector(".bs-console-input", { visible: true });
  await page.type(".bs-console-input", line);
  await page.keyboard.press("Enter");
  await wait(300);
  await page.keyboard.press("Backquote");
  await wait(150);
}

// ---------- stage: three acts and two of the three roads done ------------------------
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
for (let i = 0; i < 40 && !(await dbg(() => window.__dbgContent().packages.some((p) => p.id === "story-seam"))); i++) {
  await wait(250);
}
await setQuest("quest:seam/three-roads", "completed");
await setQuest("quest:seam/guardian-land", "completed");
await setQuest("quest:seam/guardian-sea", "completed");
await adv(0.3);

// ---------- 1. the arch, both halves --------------------------------------------------
{
  const two = await flags(["guardian-land-freed", "guardian-sea-freed", "guardian-sky-freed"]);
  const gate = (await zone()).gates.find((g) => g.to === "seam");
  check(!!gate, "the overworld has no arch to the Seam");
  await dbg((p) => window.__dbgTp(p.x, p.z), gate);
  await streamed();
  await wait(600);
  const shutHint = await hint();
  const shutZone = await zone();
  await page.keyboard.press("KeyE");
  await wait(1500);
  const stillHere = await zone();
  await dbg(() => {
    const s = window.__dbgTowns().spawn;
    window.__dbgTp(s.x, s.z);
  });
  await streamed();
  const pellShut = await talkTo("sky-gardener/encampment");
  const shelfShut = await shelfOf(Q5);
  results.shut = { two, gate: shutZone.gates.find((g) => g.to === "seam"), hint: shutHint, pell: pellShut, shelf: shelfShut, zone: stillHere.id };
  check(two["guardian-sky-freed"] !== true, "the staging left the sky thread slack too early");
  check(results.shut.gate?.shut === true, "the arch is not shut with two threads slack");
  check(shutHint !== null && /shut/i.test(shutHint), `standing in the shut arch the hint reads "${shutHint}"`);
  check(stillHere.id === "overworld", `a press in the shut arch crossed to "${stillHere.id}"`);
  check(shelfShut !== "available", `the First Bond is on the "${shelfShut}" shelf with two threads slack`);
  check((await facts(Q5, [], [])).status !== "active", "Pell started the First Bond with two threads slack");

  // The third thread: the toast, the arch, the offer.
  await setQuest("quest:seam/guardian-sky", "completed");
  await adv(0.3);
  const offer = await talkTo("sky-gardener/encampment");
  const started = await facts(Q5, ["open-the-seam"], ["guardian-sky-freed"]);
  const openGate = (await zone()).gates.find((g) => g.to === "seam");
  results.open = { offer, ...started, gate: openGate };
  check(started.status === "active", `Pell's offer left the First Bond "${started.status}"`);
  check(openGate?.shut === false, "the arch did not open with the third thread slack");
  await dbg((p) => window.__dbgTp(p.x + 6, p.z), openGate);
  await streamed();
  await wait(400);
  await dbg((p) => window.__dbgTp(p.x, p.z), openGate);
  await wait(600);
  const openHint = await hint();
  const ms = await pressAndCross("overworld");
  const arrived = await zone();
  results.cross = { hint: openHint, ms, zone: arrived.id };
  check(openHint !== null && !/shut/i.test(openHint), `the open arch's hint reads "${openHint}"`);
  check(ms !== null && arrived.id === "seam", `the press did not cross into the Seam (${arrived.id})`);
}

// ---------- 2. the Seam and Rhune ------------------------------------------------------
{
  await streamed();
  await adv(0.5);
  const s = await facts(Q5, ["open-the-seam"], []);
  check(s["open-the-seam"] >= 1, "arriving in the Seam did not mark open-the-seam");
  const arena = await dbg(() => window.__dbgQuestSites().seamArena);
  check(!!arena, "no arena sites in the Seam");
  await dbg((p) => window.__dbgTp(p.x, p.z), arena.land);
  await streamed();
  const up = await until(async () => {
    const e = await boss();
    return e && e.targetable ? e : null;
  });
  results.rhune = { arena, up };
  check(!!up, "Rhune did not stand up in the Seam");
  check(up?.bond === "ground" && up?.stage === 0, `Rhune's first phase is ${up?.bond}/${up?.stage}, not ground/0`);

  // Hurt it into the tide, then into the air: each move is the stage's, on the phase event.
  await dbg((sp) => window.__dbgKillEnemy(sp, 0.6), BOSS);
  await adv(1.5);
  const tide = await boss();
  const wet = tide ? await dbg((p) => window.__dbgSurfaceY(p.x, p.z).ground, tide) : null;
  results.tide = { tide, wet, sea: arena.sea };
  check(tide?.bond === "water" && tide?.stage === 1, `at 60% Rhune answers ${tide?.bond}/${tide?.stage}, not water/1`);
  check(tide && Math.hypot(tide.x - arena.sea.x, tide.z - arena.sea.z) < 20, "Rhune was not moved into the tide");
  check(tide && tide.y < 8 && wet !== null && tide.y > wet, `Rhune is not in the water: y ${tide?.y}, bed ${wet}`);
  await dbg((sp) => window.__dbgKillEnemy(sp, 0.3), BOSS);
  await adv(1.5);
  const air = await boss();
  results.air = { air, sky: arena.sky };
  check(air?.bond === "flying" && air?.stage === 2, `at 30% Rhune answers ${air?.bond}/${air?.stage}, not flying/2`);
  check(air && Math.hypot(air.x - arena.sky.x, air.z - arena.sky.z) < 20, "Rhune was not moved over the cloud deck");
  check(air && air.y > arena.sky.y + 2, `Rhune is not in the air over the deck: y ${air?.y}, deck ${arena.sky.y}`);
  await dbg((sp) => window.__dbgKillEnemy(sp), BOSS);
  await adv(0.5);
  const down = await facts(Q5, ["defeat-rhune"], []);
  check(down["defeat-rhune"] >= 1, "Rhune's death did not count");
}

// ---------- 3. the decision ------------------------------------------------------------
{
  const arena = await dbg(() => window.__dbgQuestSites().seamArena);
  await dbg((p) => window.__dbgTp(p.x, p.z), arena.engine);
  await streamed();
  await adv(0.5);
  const leverHint = await hint();
  await page.keyboard.press("KeyE");
  await wait(400);
  const panel = await dbg(() => ({
    open: !!document.querySelector(".bs-choice"),
    options: [...document.querySelectorAll(".bs-choice .opt")].map((b) => b.dataset.id),
  }));
  results.panel = { hint: leverHint, ...panel };
  check(leverHint !== null && /decide/i.test(leverHint), `at the engine the hint reads "${leverHint}"`);
  check(panel.open, "E at the engine did not open the choice panel");
  check(panel.options.join(",") === "severed,held,shared", `the panel offers ${JSON.stringify(panel.options)}`);
  // Escape steps back — nothing decided.
  await page.keyboard.press("Escape");
  await wait(300);
  const dismissed = await dbg(() => !document.querySelector(".bs-choice"));
  const undecided = await flags(ENDINGS);
  check(dismissed, "Escape did not close the panel");
  check(oneEnding(undecided) === 0, `a dismissal set an ending: ${JSON.stringify(undecided)}`);
  // Ask again and pick HOLD by its digit.
  await adv(0.3);
  await page.keyboard.press("KeyE");
  await wait(400);
  await page.keyboard.press("Digit2");
  await wait(400);
  const held = await facts(Q5, ["decide"], ENDINGS);
  results.held = held;
  check(held["decide"] >= 1, "picking did not count the decision");
  check(held["ending-held"] === true && oneEnding(held) === 1, `after HOLD the endings read ${JSON.stringify(held)}`);
  // Exclusivity lives where the choice is applied: another `ending.set` swaps, never stacks.
  await run([{ do: "ending.set", ending: "shared" }]);
  const swapped = await flags(ENDINGS);
  await run([{ do: "ending.set", ending: "held" }]);
  results.swapped = swapped;
  check(swapped["ending-shared"] === true && oneEnding(swapped) === 1, `ending.set stacked: ${JSON.stringify(swapped)}`);
}

// ---------- 4. the close, and the whole campaign in flags ------------------------------
{
  await cmd("/zone overworld");
  await streamed();
  await adv(0.5);
  await dbg(() => {
    const s = window.__dbgTowns().spawn;
    window.__dbgTp(s.x, s.z);
  });
  await streamed();
  const before = await shards();
  const done = await talkTo("sky-gardener/encampment");
  const closed = await facts(Q5, [], ["act-1-complete", "act-2-complete", "act-3-complete", "act-4-complete", ...ENDINGS]);
  const paid = (await shards()) - before;
  const gain = await talkTo("gain");
  const pell = await talkTo("sky-gardener/encampment");
  results.close = { done, ...closed, paid, gain, pell };
  check(closed.status === "completed", `Pell's turn-in left the First Bond "${closed.status}"`);
  check(paid === 500, `the First Bond paid ${paid}, not the promised 500`);
  for (const a of ["act-1-complete", "act-2-complete", "act-3-complete", "act-4-complete"]) {
    check(closed[a] === true, `${a} is not set at the end of the campaign`);
  }
  check(oneEnding(closed) === 1 && closed["ending-held"] === true, `the campaign ends with ${JSON.stringify(ENDINGS.filter((e) => closed[e]))}`);
  check(gain?.includes("Held") || gain?.includes("held"), "Gain's epilogue does not read the ending flag");
  check(pell?.includes("Held") || pell?.includes("lever"), "Pell's epilogue does not read the ending flag");
}

console.log(JSON.stringify({ ...results, failures: fails, pass: fails.length === 0 }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
