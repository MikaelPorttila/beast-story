// ACT 1 — LAND: the campaign, walked (issue #143, game-story.md §4).
//
// Usage: bun tools/test-story-land.mjs      (dev server must be up)
//
// THE ACT'S OWN PROBE, and it grows one section per quest as the act ships. It
// drives the game the way a player does — talk to the giver, do the thing, talk
// again — and asserts on `ContentState`, never on the words on the screen: the
// flags ARE the campaign's contract with everything downstream (Act 2 gates on
// `sea-revealed`, Act 4 on `mount-ground`), and a probe that read the journal
// card would be asserting a translation.
//
// SECTION 1 — QUEST 1, `quest:land/first-light`. Five claims, three of them
// pairs, because one arm alone passes against a broken build:
//
//   1. IT IS THE ONLY MAIN QUEST ON OFFER AT BOOT. Both halves: `first-light`
//      is offered, and no other main quest is — that is what "the campaign has
//      one entry point" means, and a build that offered Act 2 as well would
//      pass a test that only looked for the first one.
//   2. TALKING STARTS IT, and the talk row's own `progress.add` is what ticks
//      `talk-to-gain`. The status and the counter are read together: a quest
//      that went active with no progress is a dialogue that forgot half its job.
//   3. THE PRACTICE BEAST IS THERE TO THROW AT. The objective counts orb
//      throws, and a throw with nothing in aim is refused before the orb leaves
//      the hand — so "there is a Sproutle" is a precondition of the mechanic
//      and is asserted as one.
//   4. THREE THROWS ARE THREE, AND A FOURTH IS STILL THREE. The counter is
//      capped at the objective's own count, which is what stops a player who
//      kept throwing from over-counting into the next quest's arithmetic.
//   5. TURNING IT IN PAYS AND SETS. The two flags, the discovery and the
//      Cubloons, measured as a DELTA on the shard total rather than an absolute
//      — the starting purse is a number that may change and is not this
//      probe's business.
//
// SECTIONS 5 – 8 — QUEST 2, `quest:land/the-first-bond`, and the pair that runs
// through the middle of them:
//
//   6. PREREQUISITES DECIDE THE ORDER, in both directions. The quest is on no
//      shelf at all while quest 1 is unfinished (§5) and offered the moment it
//      completes (§7). Either half alone passes against a build that never
//      offers it, or one that always does.
//   7. A WILD BOND COUNTS. Driven through the real mechanic — hunt a Sproutle,
//      weaken it, force the catch — because the trigger under test is the one
//      Acts 2 and 3 inherit, filtered to their own species. `first-bond` is set
//      by the turn-in and the counter stops at the one the quest asked for.
//
// SECTION 9 — QUEST 3, `quest:land/the-mill-road`, the act's travel quest and
// the one that hands over the ground mount. Four more claims, the first of them
// a pair for the same reason the others are:
//
//   9.  THE WALK IS ON FOOT AND THE MOUNT IS ITS REWARD. Nothing is unlocked
//       while the quest is active; `ground` is unlocked the moment it closes.
//   10. THE CULL COUNTS THE CORRUPTED AND ONLY THEM — six Glooplings tick it,
//       a wild Sproutle does not.
//   11. ARRIVAL IS A PLACE, NOT A DOOR: standing in Redbriar advances the
//       travel objective and discovers the town.
//   12. THE QUEST ENDS WHERE IT SENT YOU. Gain offers it, Mera closes it, and
//       the close sets `mount-ground` — the flag Act 4 gates on — as well as
//       running the unlock.
//
// Exits non-zero on failure.
import { launchBrowser, newPage, wait } from "./browser.mjs";
import { BASE as HOST } from "./target.mjs";

// `menu=0` because everything below measures the world, and the title screen
// gates the frame loop. No `fps=` cap: nothing here is a frame-edge assertion.
const URL = `${HOST}/?menu=0&vol=0`;

const QUEST = "quest:land/first-light";
const QUEST2 = "quest:land/the-first-bond";
const QUEST3 = "quest:land/the-mill-road";
/** What the quest's own asset says, so the probe is not a second copy of it. */
const PRACTICE_THROWS = 3;
const CULL_COUNT = 6;
/** The three enemies with no `capture` block — see `what-corrupted-means` in the package. */
const CORRUPTED = "gloopling";

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
await page.waitForFunction(
  () => window.__dbgBoot && window.__dbgBoot().playing && window.__dbgJournal,
  { timeout: 60000 },
);
await wait(200);

const dbg = (fn, ...args) => page.evaluate(fn, ...args);
/**
 * The content facts, which is what every claim below is really about.
 *
 * READ THROUGH `__dbgContent`, and that is not a style choice: a dynamic
 * `import("/src/content/index.ts")` from a page.evaluate is served its own
 * module instance whenever Vite has invalidated the graph, and the runtime it
 * hands back is then a second, EMPTY registry — every quest reads "unknown"
 * against a game that is playing perfectly. The hook reads the game's own.
 */
const state = async () => {
  const doc = (await dbg(() => window.__dbgContent())).state ?? {};
  const id = "quest:land/first-light";
  const id2 = "quest:land/the-first-bond";
  const id3 = "quest:land/the-mill-road";
  // The serialised document omits empty collections and untouched counters.
  const status = (q) => doc.quests?.[q] ?? "unknown";
  const at = (q, o) => doc.progress?.[`${q}/${o}`] ?? 0;
  return {
    status: status(id),
    talk: at(id, "talk-to-gain"),
    practice: at(id, "bond-practice"),
    status2: status(id2),
    tamed: at(id2, "tame-wild"),
    status3: status(id3),
    reached: at(id3, "reach-redbriar"),
    culled: at(id3, "cull-corrupted"),
    flags: doc.flags ?? [],
    discovered: (doc.discovered ?? []).includes("town:encampment"),
    discoveredRedbriar: (doc.discovered ?? []).includes("town:redbriar"),
  };
};
/** Which shelf the journal puts a quest on right now, or null for hidden. */
const tabOf = async (id) => (await journal()).find((e) => e.id === id)?.tab ?? null;
const journal = () => dbg(() => window.__dbgJournal().model);
const purse = () => dbg(() => window.__dbgZone().shards);
const orbs = () =>
  dbg(() => {
    const row = window.__dbgZone().bag.find((b) => b.id === "orb-tame");
    return row ? row.count : 0;
  });

/**
 * Talk to a named NPC the way a player does: stand beside him and press E.
 *
 * The press has to be CONSUMED by a running frame loop (`takePress`), which is
 * why this retries and why this probe is on probe.mjs's SOLO list — a
 * backgrounded page gets no requestAnimationFrame at all and every press is
 * delivered into a game that never reads it.
 */
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

/** Dismiss the one-line dialogue panel so the next press opens a new one. */
async function endTalk() {
  await page.keyboard.press("Escape");
  await wait(250);
}

/** Advance SIMULATED seconds, so a hunt is bounded in work and not wall-clock. */
const adv = (s) => dbg((n) => window.__dbgAdvance(n), s);

/**
 * Stand the hero next to a live wild beast of this species, spawning nothing.
 *
 * Lifted from tools/test-taming.mjs, and for its reason: the population is
 * whatever `trySpawn` last topped up to, picked uniformly, so a probe that
 * demanded a Sproutle on the first look would fail on the run where the pack is
 * full of Glooplings. Hopping 130 units puts every live enemy past the despawn
 * distance, so each hop is a fresh roll.
 *
 * A HELD ANIMAL IS NOT A CANDIDATE. `held` is one already inside an orb — the
 * practice beast section 4 threw at is the common one — and every hook that
 * takes a species (`__dbgWeaken`, `__dbgThrowOrb`) looks for a TARGETABLE one,
 * so walking to a held Sproutle produced "no live wild-sproutle nearby" from
 * two calls in a row and read as a taming bug rather than the wrong animal.
 */
async function goToWild(species) {
  const home = await dbg(() => window.__dbgTowns().spawn);
  const pick = (list) => list.find((x) => x.species === species && !x.held);
  for (let tries = 0; tries < 24; tries++) {
    const e = pick((await dbg(() => window.__dbgBodies())).enemies);
    if (!e) {
      const a = tries * 1.31;
      await dbg(
        (x, z) => window.__dbgTp(x, z),
        home.x + Math.cos(a) * 130,
        home.z + Math.sin(a) * 130,
      );
      await adv(3);
      continue;
    }
    // Three units off: well inside the orb's range, and close enough that the
    // throw cannot clip the ground on the way.
    await dbg((x, z) => window.__dbgTp(x, z), e.x + 3, e.z + 3);
    await adv(0.3);
    const after = pick((await dbg(() => window.__dbgBodies())).enemies);
    if (after) {
      return after;
    }
  }
  return null;
}

// ---------- 1. the campaign has exactly one entry point ---------------------
{
  const model = await journal();
  const main = model.filter((e) => e.category === "main");
  const offered = main.filter((e) => e.tab === "available").map((e) => e.id);
  results.entryPoint = {
    mainQuests: main.map((e) => ({ id: e.id, tab: e.tab })),
    offered,
    state: await state(),
  };
  check(
    offered.includes(QUEST),
    `${QUEST} is not offered on a fresh character: ${JSON.stringify(offered)}`,
  );
  check(
    offered.length === 1,
    `${offered.length} main quests are offered at boot, not 1: ${JSON.stringify(offered)}`,
  );
  check(
    results.entryPoint.state.status === "unknown",
    `the opening quest starts at "${results.entryPoint.state.status}", not untouched`,
  );
}

// ---------- 2. talking to Gain starts it ------------------------------------
{
  const line = await talkTo("gain");
  await endTalk();
  const s = await state();
  results.offer = { line, ...s, orbs: await orbs() };
  check(line !== null, "could not get a word out of Gain");
  check(s.status === "active", `the quest is "${s.status}" after talking to its giver`);
  check(s.talk === 1, `talk-to-gain is ${s.talk} after one conversation, not 1`);
  // `onStart` hands over the practice orbs, which is the lifecycle runner doing
  // its job: nothing but a status change happened, and an action list ran.
  check(
    results.offer.orbs >= PRACTICE_THROWS,
    `only ${results.offer.orbs} taming orbs after the quest started — onStart did not pay out`,
  );
}

// ---------- 3. there is something to practise on ----------------------------
{
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await wait(250);
    target = (await dbg(() => window.__dbgTaming("wild-sproutle"))).target;
  }
  results.practiceBeast = target;
  check(
    target !== null,
    "no wild Sproutle was staged for the practice — a throw at nothing is refused " +
      "before the orb leaves the hand, so the objective could never tick",
  );
}

// ---------- 4. three throws, and a fourth that changes nothing --------------
{
  const throws = [];
  for (let i = 0; i < PRACTICE_THROWS + 1; i++) {
    // A settling orb refuses the next throw (`busy`), so wait out the ceremony
    // rather than guessing at its length.
    for (let w = 0; w < 40; w++) {
      if (!(await dbg(() => window.__dbgTaming())).bonding) {
        break;
      }
      await wait(250);
    }
    // `false` BREAKS the orb on purpose. The objective counts the throw and not
    // the catch, and a rolled outcome would make this a test that fails one run
    // in however-many.
    throws.push(await dbg(() => window.__dbgThrowOrb("wild-sproutle", false)));
    await wait(400);
  }
  const s = await state();
  results.practice = { throws: throws.map((t) => t.outcome), progress: s.practice };
  check(
    throws.slice(0, PRACTICE_THROWS).every((t) => t.outcome === "thrown"),
    `a practice throw was refused: ${JSON.stringify(results.practice.throws)}`,
  );
  check(
    s.practice === PRACTICE_THROWS,
    `bond-practice is ${s.practice} after ${PRACTICE_THROWS + 1} throws, not capped at ${PRACTICE_THROWS}`,
  );
}

// ---------- 5. quest 2 is locked until quest 1 is done ----------------------
// The FIRST half of the pair. Section 7 is the second, and the two of them are
// what "prerequisites decide the order" means: this quest is invisible now and
// offered the moment the one before it completes. One arm alone passes against
// a build that never offers it and against one that always does.
{
  const tab = await tabOf(QUEST2);
  results.gateBefore = { tab, status: (await state()).status2 };
  check(tab === null, `${QUEST2} is on the "${tab}" shelf before its prerequisite is done`);
}

// ---------- 6. the turn-in pays and sets ------------------------------------
{
  const before = await purse();
  const line = await talkTo("gain");
  await endTalk();
  const s = await state();
  const after = await purse();
  results.turnIn = {
    line,
    status: s.status,
    flags: s.flags,
    discovered: s.discovered,
    shardsBefore: before,
    shardsAfter: after,
  };
  check(s.status === "completed", `the quest is "${s.status}" after the turn-in`);
  check(s.flags.includes("taming-learned"), "taming-learned was not set");
  check(s.flags.includes("met-gain"), "met-gain was not set");
  check(s.discovered === true, "town:encampment was not discovered");
  check(
    after - before === 10,
    `the reward paid ${after - before} Cubloons, not the 10 the quest promises`,
  );
}

// ---------- 7. quest 2 is offered the moment quest 1 completes --------------
{
  const tab = await tabOf(QUEST2);
  results.gateAfter = { tab };
  check(
    tab === "available",
    `${QUEST2} is on the "${tab}" shelf after its prerequisite completed, not "available"`,
  );
}

// ---------- 8. the wild bond ------------------------------------------------
// THE TAMING TRIGGER, which is the piece Acts 2 and 3 inherit — the same fact,
// filtered to their own species. Driven through the real bond: weaken an animal
// and force the catch, because the ODDS are `test-taming`'s business and a
// rolled outcome here would be a probe that fails one run in eight.
{
  const line = await talkTo("gain");
  await endTalk();
  let started = await state();
  results.bondQuest = { offerLine: line, statusAfterOffer: started.status2 };
  check(started.status2 === "active", `${QUEST2} is "${started.status2}" after being offered`);

  // A SPROUTLE SPECIFICALLY, because it is the only bondable species a starting
  // orb can hold: `orb-tame` is tier 1 and both other wild beasts ask for tier
  // 2 (`capture.minTier` in core.json). Which is also the quest's own answer to
  // "any ground species" at this point in the game.
  // AN ORB MAY MISS, AND A MISS IS NOT THE FAILURE UNDER TEST. The claim here is
  // that a wild bond TICKS THE OBJECTIVE; whether a given throw clears the
  // ground between two points is `test-taming`'s subject and the loft's. So the
  // throw is retried, and the bag is topped up first so an empty one can never
  // be mistaken for a bad flight. SIX attempts, because the miss rate against a
  // live wild Sproutle at 3-4 units measured about one throw in three (issue
  // #197) — three attempts still lost one run in three.
  await dbg(() => window.__dbgGive("orb-tame", 8));
  let found = null;
  let hurt = null;
  let thrown = null;
  let landed = false;
  for (let attempt = 0; attempt < 6 && !landed; attempt++) {
    found = await goToWild("wild-sproutle");
    if (!found) {
      break;
    }
    hurt = await dbg(() => window.__dbgWeaken("wild-sproutle", 0.1));
    thrown = await dbg(() => window.__dbgThrowOrb("wild-sproutle", true));
    // THE ORB HAS TO ARRIVE. "Not bonding" is true the instant after a throw, so
    // the ceremony is waited FOR and then waited OUT — the two halves of "it
    // landed", the same pair tools/test-taming.mjs makes.
    for (let i = 0; i < 24 && !landed; i++) {
      await adv(0.1);
      landed = (await dbg(() => window.__dbgTaming())).bonding;
    }
  }
  for (let i = 0; i < 60 && (await dbg(() => window.__dbgTaming())).bonding; i++) {
    await adv(0.1);
  }
  await adv(0.3);
  const s = await state();
  results.bondQuest.bond = { found, hurt, throw: thrown, landed, progress: s.tamed };
  check(found !== null, "no wild Sproutle ever turned up outside the camp to bond");
  check(thrown?.outcome === "thrown", `the orb was refused: ${JSON.stringify(thrown)}`);
  check(landed, `no orb reached a Sproutle (last ${thrown?.dist} units away)`);
  check(s.tamed === 1, `tame-wild is ${s.tamed} after a wild bond, not 1`);

  // The turn-in, and the flag it sets EXACTLY ONCE however many beasts follow.
  const line2 = await talkTo("gain");
  await endTalk();
  const done = await state();
  results.bondQuest.turnIn = {
    line: line2,
    status: done.status2,
    flag: done.flags.includes("first-bond"),
  };
  check(done.status2 === "completed", `${QUEST2} is "${done.status2}" after the turn-in`);
  check(done.flags.includes("first-bond"), "first-bond was not set");
  // The counter did not run past what the objective asked for, which is the
  // other half of "however many beasts you bond, this happens once".
  check(done.tamed === 1, `tame-wild ended at ${done.tamed}, not the 1 the quest asks for`);
}

// ---------- 9. the mill road --------------------------------------------
// QUEST 3, and the act's one travel quest. Four claims:
//
//   9.  THE WALK IS ON FOOT, both halves. Nothing is unlocked while the quest
//       is active, and `ground` is unlocked the moment it is handed in — one
//       arm alone passes against a build that unlocks nothing and against one
//       that unlocked everything at boot.
//   10. THE CULL COUNTS THE CORRUPTED AND ONLY THEM. Six Glooplings tick it to
//       six; a wild Sproutle, which is a beast the game just taught you to
//       BOND, ticks it not at all.
//   11. ARRIVAL IS A PLACE. Walking into Redbriar advances `reach-redbriar`
//       and discovers the town, off the hero's position and no gate.
//   12. THE TURN-IN IS SOMEBODY ELSE. Gain offers it at the camp and Mera
//       closes it at the mill (`turnIn` on the asset), and what it sets is the
//       flag Act 4 reads — `mount-ground` — beside the unlock itself.
{
  const line = await talkTo("gain");
  await endTalk();
  let s = await state();
  results.millRoad = { offerLine: line, status: s.status3 };
  check(s.status3 === "active", `${QUEST3} is "${s.status3}" after being offered`);

  // 9a. ON FOOT. The mount gate reads the unlock set, so this is the whole claim.
  const beforeMount = await dbg(() => window.__dbgMount().unlocked);
  results.millRoad.unlockedWhileWalking = beforeMount;
  check(
    Array.isArray(beforeMount) && beforeMount.length === 0,
    `a mount was already unlocked during the walk: ${JSON.stringify(beforeMount)}`,
  );

  // 10. THE CULL. Spawned rather than hunted: the population is what `trySpawn`
  // last topped up to, and this measures the TRIGGER, not the spawner's odds.
  const kills = [];
  for (let i = 0; i < CULL_COUNT; i++) {
    await dbg((sp) => window.__dbgSpawn("enemies", sp), CORRUPTED);
    await adv(0.2);
    kills.push(await dbg((sp) => window.__dbgKillEnemy(sp), CORRUPTED));
    // The death is swept on the next slice, and the fact goes out from there.
    await adv(0.3);
  }
  s = await state();
  results.millRoad.cull = { kills: kills.map((k) => k.ok), culled: s.culled };
  check(
    kills.every((k) => k.ok),
    `a corrupted beast could not be put down: ${JSON.stringify(results.millRoad.cull.kills)}`,
  );
  check(s.culled === CULL_COUNT, `cull-corrupted is ${s.culled} after ${CULL_COUNT} kills`);

  // 10b. AND ONLY THE CORRUPTED. A wild Sproutle is a beast you are meant to
  // bond, so a cull that counted one would be the quest asking for the opposite
  // of what quest 2 just taught. The counter is already AT its cap, so this is
  // measured on the way up instead — six is six after a seventh, wilder, death.
  await dbg(() => window.__dbgSpawn("enemies", "wild-sproutle"));
  await adv(0.2);
  const wildKill = await dbg(() => window.__dbgKillEnemy("wild-sproutle"));
  await adv(0.3);
  s = await state();
  results.millRoad.wildKill = { kill: wildKill.ok, culled: s.culled };
  check(wildKill.ok, "no wild Sproutle could be spawned to prove the filter");
  check(
    s.culled === CULL_COUNT,
    `killing a wild Sproutle moved cull-corrupted to ${s.culled} — the filter is not filtering`,
  );

  // 11. ARRIVAL. Teleported rather than walked: the road to Redbriar is minutes
  // of driving and what is under test is the arrival, not the pathing.
  check(s.reached === 0, `reach-redbriar was already ${s.reached} before reaching the town`);
  const town = await dbg(() => window.__dbgTowns().towns.find((t) => t.id === "redbriar"));
  await dbg((t) => window.__dbgTp(t.x, t.z), town);
  await adv(0.5);
  s = await state();
  results.millRoad.arrival = {
    town: town && { x: town.x, z: town.z },
    reached: s.reached,
    discovered: s.discoveredRedbriar,
  };
  check(town !== undefined, "the world planned no Redbriar to walk into");
  check(s.reached === 1, `reach-redbriar is ${s.reached} standing in Redbriar, not 1`);
  check(s.discoveredRedbriar === true, "walking into Redbriar did not discover it");

  // 12. THE TURN-IN, at the mill and not at the fire.
  const beforeShards = await purse();
  const meraLine = await talkTo("mera");
  await endTalk();
  s = await state();
  const unlocked = await dbg(() => window.__dbgMount().unlocked);
  results.millRoad.turnIn = {
    line: meraLine,
    status: s.status3,
    flags: s.flags,
    unlocked,
    paid: (await purse()) - beforeShards,
  };
  check(meraLine !== null, "Mera is not standing in Redbriar to take the quest in");
  check(s.status3 === "completed", `${QUEST3} is "${s.status3}" after the turn-in`);
  // BOTH, always: the action changes what the player can do, the flag is what
  // Act 4 is allowed to test, and emitting one without the other is the bug
  // this pair exists to catch (issue #149).
  check(s.flags.includes("mount-ground"), "mount-ground was not set");
  check(
    Array.isArray(unlocked) && unlocked.includes("ground"),
    `the ground mount is still locked after the quest that grants it: ${JSON.stringify(unlocked)}`,
  );
  check(
    results.millRoad.turnIn.paid === 40,
    `the reward paid ${results.millRoad.turnIn.paid} Cubloons, not the 40 the quest promises`,
  );
}

console.log(JSON.stringify(results, null, 2));
if (fails.length) {
  console.error(`\n${fails.length} failure(s):`);
  for (const f of fails) {
    console.error(`  ${f}`);
  }
}
await browser.close();
process.exit(fails.length ? 1 : 0);
