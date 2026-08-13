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
// SECTION 11 — QUEST 5, `quest:land/the-bellwether`, the act's boss and the
// seam out of Act 1: the warden opens it, the herd's leader is put out on open
// country outside Stonewatch when the player comes to meet it, the arena is
// re-enterable with the boss dead (Act 4 needs that ground again), and the
// turn-in sets `sea-revealed` and `act-1-complete` — the act closes on flags,
// never on a counter.
//
// SECTION 10 — QUEST 4, `quest:land/the-red-thread`, the act's dungeon: going
// down is an objective, the hold's floor is STAGED while the quest is live (a
// generated zone has nowhere to author a prop), freeing the Sproutle is the
// same `tamed` fact quest 2 counts with a `zone` on it, the shard is walked
// onto, and leaving and coming back keeps every one of them — which is the
// ticket's own acceptance and the reason progress lives in `ContentState`.
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
const QUEST4 = "quest:land/the-red-thread";
/** What the Hold's floor holds while quest 4 is live. */
const SHARD_ITEM = "red-shard";
/** What the thread is wound onto — killing it is what frees the animal. */
const ANCHOR = "thread-anchor";
const QUEST5 = "quest:land/the-bellwether";
/** The animal the rest of the valley is following. */
const BOSS = "bellwether";
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
  const id4 = "quest:land/the-red-thread";
  const id5 = "quest:land/the-bellwether";
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
    status4: status(id4),
    entered: at(id4, "enter-the-hold"),
    freed: at(id4, "free-the-sproutle"),
    shard: at(id4, "recover-shard"),
    discoveredHold: (doc.discovered ?? []).includes("zone:hold"),
    status5: status(id5),
    metWarden: at(id5, "meet-the-warden"),
    slain: at(id5, "defeat-bellwether"),
    discoveredStonewatch: (doc.discovered ?? []).includes("town:stonewatch"),
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

/**
 * Run one dev-console line and hand back what it printed.
 *
 * Lifted from tools/test-content.mjs, and used here for `/zone`: a quest that
 * sends the player into a dungeon has to get there, and the gateway's approach
 * and dwell are the zone manager's subject, not this file's.
 */
async function cmd(line, expect = 1) {
  const before = await page.evaluate(
    () => document.querySelectorAll(".bs-console-log .bs-console-line").length,
  );
  await page.keyboard.press("Backquote");
  await page.waitForSelector(".bs-console-input", { visible: true });
  await page.type(".bs-console-input", line);
  await page.keyboard.press("Enter");
  let out = [];
  for (let i = 0; i < 40; i++) {
    await wait(150);
    out = await page.evaluate(
      (n) =>
        [...document.querySelectorAll(".bs-console-log .bs-console-line")]
          .slice(n)
          .map((el) => el.textContent),
      before,
    );
    if (out.length > expect) {
      break;
    }
  }
  await page.keyboard.press("Backquote");
  await wait(150);
  return out;
}

/**
 * Bond one wild beast of this species, the way a player does, and keep at it
 * until the game says it is yours.
 *
 * WHAT IS RETRIED AND WHY: a throw can miss (issue #198), and a ceremony that
 * plays can still end with a broken orb. Neither is the claim any section here
 * makes — every one of them is about what a COMPLETED bond does to a quest — so
 * the loop watches `__dbgFetch().owned`, which is the game's own answer to "is
 * this beast yours", and throws again until it says yes.
 */
async function bondAWild(species, beast) {
  await dbg(() => window.__dbgGive("orb-tame", 8));
  const isOwned = async () => (await dbg(() => window.__dbgFetch())).owned.includes(beast);
  const out = { attempts: 0, found: null, throws: [], owned: await isOwned() };
  for (let attempt = 0; attempt < 6 && !out.owned; attempt++) {
    out.attempts++;
    out.found = await goToWild(species);
    if (!out.found) {
      break;
    }
    await dbg((sp) => window.__dbgWeaken(sp, 0.1), species);
    out.throws.push(await dbg((sp) => window.__dbgThrowOrb(sp, true), species));
    // Long enough for the whole ceremony — a suck and three wobbles, about two
    // seconds — plus the flight it may still be in.
    for (let i = 0; i < 60 && !out.owned; i++) {
      await adv(0.1);
      out.owned = await isOwned();
    }
  }
  return out;
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
  const bond = await bondAWild("wild-sproutle", "sproutle");
  const s = await state();
  results.bondQuest.bond = { ...bond, progress: s.tamed };
  check(bond.found !== null, "no wild Sproutle ever turned up outside the camp to bond");
  check(bond.owned, `no Sproutle was bonded in ${bond.attempts} attempts`);
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

// ---------- 10. the red thread -------------------------------------------
// QUEST 4, the act's dungeon. Four claims:
//
//   13. GOING DOWN IS THE OBJECTIVE. Arriving in `hold` advances
//       `enter-the-hold` and discovers the zone.
//   14. THE HOLD'S FLOOR IS STAGED WHILE THE QUEST IS LIVE: a Sproutle to free
//       and the shard beside it, in a zone that is generated and has nowhere to
//       author a prop.
//   15. FREEING IS KILLING WHAT HOLDS IT, and the animal survives it. The
//       `enemy-killed` fact quest 3 counts, with a `zone` on it, so a Gloopling
//       put down on the drove road moves nothing here.
//   16. LEAVING AND COMING BACK KEEPS THE PROGRESS (the ticket's own
//       acceptance), and the turn-in sets `red-thread-seen`.
{
  const offer = await talkTo("mera");
  await endTalk();
  let s = await state();
  results.redThread = { offerLine: offer, status: s.status4 };
  check(s.status4 === "active", `${QUEST4} is "${s.status4}" after being offered`);
  check(s.entered === 0, `enter-the-hold was already ${s.entered} up in the valley`);

  // 13. DOWN. Through the console rather than the gateway: the dwell and the
  // approach are `test-dive`'s and the zone manager's subject, and what is
  // under test here is the fact the arrival produces.
  await cmd("/zone hold");
  await adv(0.5);
  s = await state();
  results.redThread.arrival = {
    zone: await dbg(() => window.__dbgZone().id),
    entered: s.entered,
    discovered: s.discoveredHold,
  };
  check(results.redThread.arrival.zone === "hold", "the console did not put the hero in the hold");
  check(s.entered === 1, `enter-the-hold is ${s.entered} standing in the hold, not 1`);
  check(s.discoveredHold === true, "arriving in the hold did not discover it");

  // 14. THE FLOOR IS SET, and it is set WHERE THE FLOOR IS. The shard is laid
  // down from anywhere; the two living halves are put out only once the hero is
  // near enough to keep them, because an enemy spawned 136 units from him is
  // swept the slice it is made. So the probe walks in the same order a player
  // does: down, across to the room, and then the room is dressed.
  let staged = null;
  for (let i = 0; i < 25 && !staged; i++) {
    await adv(1);
    const drops = (await dbg(() => window.__dbgFetch())).drops.filter(
      (d) => d.itemId === SHARD_ITEM,
    );
    if (drops.length === 0) {
      continue;
    }
    // The shard IS the floor's coordinate — the stage puts it there — so the
    // probe needs no copy of the hold's layout to find the room.
    await dbg((d) => window.__dbgTp(d.x, d.z), drops[0]);
    await adv(1);
    const bodies = (await dbg(() => window.__dbgBodies())).enemies;
    const anchor = bodies.find((e) => e.species === ANCHOR);
    const penned = bodies.find((e) => e.species === "wild-sproutle");
    if (anchor && penned) {
      staged = { anchor, penned, drop: drops[0] };
    }
  }
  results.redThread.staged = staged;
  check(
    staged !== null,
    "the hold's floor was never staged — the anchor, the Sproutle it holds and the shard are one scene and all three have to be there",
  );

  // 15. CUTTING IT LOOSE. The anchor is what is killed and the animal is what is
  // freed — the two are deliberately different things, because a player who
  // bonded a Sproutle in quest 2 cannot bond another one.
  if (staged) {
    await dbg((a) => window.__dbgTp(a.x + 2, a.z + 2), staged.anchor);
    await adv(0.3);
    results.redThread.cut = await dbg((sp) => window.__dbgKillEnemy(sp), ANCHOR);
    await adv(0.4);
  }
  s = await state();
  results.redThread.freed = { progress: s.freed };
  check(s.freed === 1, `free-the-sproutle is ${s.freed} after cutting the anchor down, not 1`);
  // AND THE ANIMAL IS NOT WHAT WAS SPENT: it is still standing there, freed
  // rather than bonded or killed, which is the whole image of the beat.
  const stillThere = (await dbg(() => window.__dbgBodies())).enemies.some(
    (e) => e.species === "wild-sproutle",
  );
  results.redThread.sproutleSurvives = stillThere;
  check(stillThere, "the Sproutle the quest is about did not survive being freed");

  // 16a. THE SHARD. Walking onto it is the whole mechanic, so this is measured
  // wherever it happened: the hero crossed the floor to reach the anchor, and a
  // pickup he walked over on the way is the same fact as one he was sent for.
  const stillDown = (await dbg(() => window.__dbgFetch())).drops.find(
    (d) => d.itemId === SHARD_ITEM,
  );
  if (stillDown) {
    await dbg((d) => window.__dbgTp(d.x, d.z), stillDown);
    for (let i = 0; i < 20 && (await state()).shard === 0; i++) {
      await adv(0.3);
    }
  }
  s = await state();
  const carried = (await dbg(() => window.__dbgZone())).bag.find((b) => b.id === SHARD_ITEM);
  results.redThread.shard = {
    onFloor: stillDown ?? null,
    carried: carried ?? null,
    progress: s.shard,
  };
  check(s.shard === 1, `recover-shard is ${s.shard} after walking onto the shard, not 1`);
  // IN THE BAG, not merely counted: it is a `quest` item, so it cannot be
  // salvaged or dropped, and the objective and the bag must agree.
  check(carried !== undefined, "the shard ticked the objective but never reached the bag");

  // 16b. OUT AND BACK IN. The ticket's own acceptance: progress is facts in
  // `ContentState`, not something a zone owns and disposes with its meshes.
  await cmd("/zone overworld");
  await adv(0.5);
  await cmd("/zone hold");
  await adv(0.5);
  const back = await state();
  results.redThread.roundTrip = {
    entered: back.entered,
    freed: back.freed,
    shard: back.shard,
  };
  check(
    back.entered === 1 && back.freed === 1 && back.shard === 1,
    `leaving the hold and returning changed the progress: ${JSON.stringify(results.redThread.roundTrip)}`,
  );

  // 16c. THE TURN-IN, back at the mill.
  await cmd("/zone overworld");
  await adv(0.5);
  const beforeShards = await purse();
  const line = await talkTo("mera");
  await endTalk();
  const done = await state();
  results.redThread.turnIn = {
    line,
    status: done.status4,
    flags: done.flags,
    paid: (await purse()) - beforeShards,
  };
  check(done.status4 === "completed", `${QUEST4} is "${done.status4}" after the turn-in`);
  check(done.flags.includes("red-thread-seen"), "red-thread-seen was not set");
  check(
    results.redThread.turnIn.paid === 60,
    `the reward paid ${results.redThread.turnIn.paid} Cubloons, not the 60 the quest promises`,
  );
}

// ---------- 11. the bellwether, and the seam out of Act 1 -------------------
// THE LAST QUEST OF THE ACT, and the assertions are about the SEAM as much as
// the fight:
//
//   17. THE GATE, BOTH WAYS. The quest is on no shelf while The Red Thread is
//       unfinished and offered by the warden the moment it is done.
//   18. THE ARENA IS OPEN COUNTRY. The Bellwether stands on the drove ground
//       outside Stonewatch, is put out when the player comes to meet it, and
//       leaves nothing behind — the ground is re-enterable with the boss dead,
//       which is what Act 4 needs of it.
//   19. THE ACT CLOSES ON FLAGS, not on a counter: `sea-revealed` and
//       `act-1-complete`, both set by the turn-in, plus the discovery.
{
  const before = await tabOf(QUEST5);
  results.bellwether = { tabBeforePrereq: before };
  // Section 10 finished The Red Thread, so this reads the AFTER half; the BEFORE
  // half is section 5's shape and is asserted there for quest 2. What is left to
  // prove here is that the warden — and only the warden — opens it.
  const offer = await talkTo("coil/stonewatch");
  await endTalk();
  let s = await state();
  results.bellwether.offer = { line: offer, status: s.status5 };
  check(offer !== null, "Warden Coil is not standing in Stonewatch");
  check(s.status5 === "active", `${QUEST5} is "${s.status5}" after the warden offered it`);

  // 18. THE ARENA. Walk out of the town on the bearing the stage uses, which is
  // away from the gate, and let the herd's leader be put out.
  // WHERE THE GAME PUT IT, not where this file would have: the arena is derived
  // from Stonewatch's own gate, and a probe that recomputed the bearing would be
  // asserting its own copy of that arithmetic.
  const at = await dbg(() => window.__dbgQuestSites().droveGround);
  await dbg((p) => window.__dbgTp(p.x, p.z), at);
  let boss = null;
  for (let i = 0; i < 20 && !boss; i++) {
    await adv(1);
    boss = (await dbg(() => window.__dbgBodies())).enemies.find((e) => e.species === BOSS) ?? null;
  }
  s = await state();
  results.bellwether.arena = { at, boss, metWarden: s.metWarden };
  check(boss !== null, "no Bellwether was ever put out on the drove ground");
  // Hearing her out is the quest's own first objective, and her offer row is
  // what ticked it — the same shape quest 1's `talk-to-gain` has.
  check(s.metWarden === 1, `meet-the-warden is ${s.metWarden} after hearing her out, not 1`);

  // The kill, through the same death every enemy dies (drops, xp, the fact).
  const killed = await dbg((sp) => window.__dbgKillEnemy(sp), BOSS);
  await adv(0.5);
  s = await state();
  results.bellwether.kill = { killed, slain: s.slain };
  check(s.slain === 1, `defeat-bellwether is ${s.slain} with the boss dead, not 1`);

  // AND THE GROUND SURVIVES IT: walk away, come back, and there is no second
  // Bellwether and nothing left standing. Act 4 stages its own boss here.
  await dbg((p) => window.__dbgTp(p.x + 260, p.z), at);
  await adv(2);
  await dbg((p) => window.__dbgTp(p.x, p.z), at);
  await adv(3);
  const again = (await dbg(() => window.__dbgBodies())).enemies.filter((e) => e.species === BOSS);
  results.bellwether.reenter = { standing: again.length };
  check(again.length === 0, `the arena put out ${again.length} more Bellwethers after its death`);

  // 19. THE SEAM.
  const beforeShards = await purse();
  const line = await talkTo("coil/stonewatch");
  await endTalk();
  const done = await state();
  results.bellwether.turnIn = {
    line,
    status: done.status5,
    flags: done.flags,
    discovered: done.discoveredStonewatch,
    paid: (await purse()) - beforeShards,
  };
  check(done.status5 === "completed", `${QUEST5} is "${done.status5}" after the turn-in`);
  check(done.flags.includes("sea-revealed"), "sea-revealed was not set — Act 2 has no key");
  check(done.flags.includes("act-1-complete"), "act-1-complete was not set");
  check(done.discovered === true, "town:stonewatch was not discovered");
  check(
    results.bellwether.turnIn.paid === 120,
    `the reward paid ${results.bellwether.turnIn.paid} Cubloons, not the 120 the quest promises`,
  );
  // NOTHING IS LEFT ON THE SHELF: with the act closed, no main quest of arc
  // `land` is still offered or active. Act 2's own gate is asserted by its
  // package when it ships (#144) — `quest:sea/salt-and-rope` does not exist yet.
  const left = (await journal()).filter(
    (e) => e.category === "main" && (e.tab === "active" || e.tab === "available"),
  );
  results.bellwether.leftOver = left.map((e) => e.id);
  check(
    left.length === 0,
    `the act closed with main quests still on the shelf: ${JSON.stringify(results.bellwether.leftOver)}`,
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
