// ACT 4, QUEST 1 — THREE ROADS (issue #162): the homecoming at the Encampment
// fire, and the fork the cast sends you down.
//
// Usage: bun tools/test-three-roads.mjs      (dev server must be up)
//
// Claims:
//
//   1. THE DOOR, BOTH HALVES: Three Roads is not offered with The Orrery open,
//      and is offered once it is closed — `story-seam` loads on act-3-complete.
//   2. THE CAST COMES HOME, BOTH HALVES: none of Coil, Vane, Pell and Tobin
//      stands at the Encampment before act-3-complete; all four do after it —
//      placed live, mid-session, by `Npcs.reconcile` when the package lands.
//      Clear the flag and they are gone again (`NpcData.present`).
//   3. HEARING THEM OUT: Gain offers and will not close until all four are
//      heard; each of the four ticks its own objective through the `npc-talk`
//      trigger — once, no matter how often you ask; Gain then closes it —
//      seam-known set, 150 paid — and each of the four now names the road that
//      is theirs.
//
// Exits non-zero on failure.
import { launchBrowser, newPage, wait } from "./browser.mjs";
import { BASE as HOST, NO_WARMUP } from "./target.mjs";

const URL = `${HOST}/?menu=0&fs=0&vol=0&debug=1&${NO_WARMUP}`;
const Q1 = "quest:seam/three-roads";
const CAST = ["coil/encampment", "sky-pilot/encampment", "sky-gardener/encampment", "sky-lamplighter/encampment"];
const HEARD = ["hear-coil", "hear-vane", "hear-pell", "hear-tobin"];

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
const atCamp = () =>
  dbg((ids) => {
    const all = window.__dbgNpcs().all;
    return ids.filter((id) => all.some((n) => n.id === id && n.town === "encampment"));
  }, CAST);
const streamed = async () => {
  for (let i = 0; i < 80 && (await dbg(() => window.__dbgZone().streaming)); i++) {
    await wait(250);
  }
};

/**
 * Stand within talk range of the target and press E. The fire is a CROWD — five
 * people three units apart around a hearth and a hut — so the spot is searched:
 * bearings around him at conversation distance, first one where the shipped
 * query (`inTalkRange`) answers HIM wins. E talks to the nearest.
 */
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

// ---------- stage: everything up to Act 3's closer done -----------------------
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
  ]) {
    content.state.setQuestStatus(q, "completed");
  }
});
await adv(0.3);

// ---------- 1 + 2. the door and the cast, both halves ------------------------
{
  const before = { shelf: await shelfOf(Q1), cast: await atCamp() };
  check(before.shelf !== "available", `Three Roads is on the "${before.shelf}" shelf with The Orrery open`);
  check(before.cast.length === 0, `at the fire before act-3-complete: ${JSON.stringify(before.cast)}`);

  await setQuest("quest:sky/the-orrery", "completed");
  // The package loads async and the people are placed when the definitions land — polled.
  let after = null;
  for (let i = 0; i < 40 && !(after?.shelf === "available" && after.cast.length === CAST.length); i++) {
    await wait(250);
    after = { shelf: await shelfOf(Q1), cast: await atCamp() };
  }
  after.packages = await dbg(() => window.__dbgContent().packages.map((p) => p.id));
  after.diagnostics = await dbg(() => window.__dbgContent().diagnostics);
  results.door = { before, after };
  check(after.packages.includes("story-seam"), "story-seam did not load on act-3-complete");
  check(after.shelf === "available", `Three Roads is on the "${after.shelf}" shelf with The Orrery closed`);
  check(after.cast.length === CAST.length, `at the fire after act-3-complete: ${JSON.stringify(after.cast)}`);
  check(after.diagnostics.length === 0, `the act raised findings: ${JSON.stringify(after.diagnostics)}`);

  // And the other direction of `present`: the flag gone, the fire empties.
  await dbg(async () => {
    const { content } = await import("/src/content/index.ts");
    content.run([{ do: "flag.clear", flag: "act-3-complete" }]);
  });
  const gone = await atCamp();
  await dbg(async () => {
    const { content } = await import("/src/content/index.ts");
    content.run([{ do: "flag.set", flag: "act-3-complete" }]);
  });
  const back = await atCamp();
  results.present = { gone, back };
  check(gone.length === 0, `still at the fire with act-3-complete cleared: ${JSON.stringify(gone)}`);
  check(back.length === CAST.length, `not back at the fire with the flag reset: ${JSON.stringify(back)}`);
}

// ---------- 3. hearing them out ------------------------------------------------
{
  await dbg(() => {
    const s = window.__dbgTowns().spawn;
    window.__dbgTp(s.x, s.z);
  });
  await streamed();
  const before = await shards();
  const offer = await talkTo("gain");
  let s = await facts(Q1, HEARD, []);
  check(offer !== null, "Gain has no Three Roads offer at the fire");
  check(s.status === "active", `Gain's offer left Three Roads "${s.status}"`);
  check(HEARD.every((k) => s[k] === 0), `an objective was marked by the offer: ${JSON.stringify(s)}`);
  // Nobody heard: he does not close.
  const early = await talkTo("gain");
  s = await facts(Q1, HEARD, []);
  check(s.status === "active", `Gain closed Three Roads with nobody heard ("${s.status}")`);
  results.early = early;

  // The four, each once — and Coil twice, to prove a second hearing counts nothing.
  const heard = {};
  for (let i = 0; i < CAST.length; i++) {
    heard[CAST[i]] = await talkTo(CAST[i]);
    if (i === 0) {
      await talkTo(CAST[0]);
    }
    s = await facts(Q1, HEARD, []);
    check(s[HEARD[i]] === 1, `${HEARD[i]} counted ${s[HEARD[i]]} after hearing ${CAST[i]}`);
    check(s.status === "active", `Three Roads went "${s.status}" before Gain closed it`);
  }
  results.heard = { lines: heard, ...s };
  check(Object.values(heard).every((l) => l !== null), `someone at the fire had nothing to say: ${JSON.stringify(heard)}`);

  const done = await talkTo("gain");
  const closed = await facts(Q1, HEARD, ["seam-known"]);
  const paid = (await shards()) - before;
  results.closed = { done, ...closed, paid };
  check(closed.status === "completed", `Gain's turn-in left Three Roads "${closed.status}"`);
  check(closed["seam-known"] === true, "seam-known was not set — Act 4 has no key");
  check(paid === 150, `Three Roads paid ${paid}, not the promised 150`);

  // Afterwards each of them names their road, and the marks are down.
  const after = {};
  for (const id of CAST) {
    after[id] = await talkTo(id);
  }
  results.after = after;
  check(after["coil/encampment"]?.includes("Kelphold"), "Coil does not send you to the trench");
  check(after["sky-gardener/encampment"]?.includes("Orrery"), "Pell does not send you to the frame");
  check(after["sky-lamplighter/encampment"]?.includes("Stonewatch"), "Tobin does not send you to the drove ground");
  const marks = await dbg(() => window.__dbgQuestMarks().marked.npcs);
  check(!marks.some((m) => CAST.includes(m.id)), `a fire mark outlived the quest: ${JSON.stringify(marks)}`);
}

console.log(JSON.stringify({ ...results, failures: fails, pass: fails.length === 0 }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
