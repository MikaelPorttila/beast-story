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
// Exits non-zero on failure.
import { launchBrowser, newPage, wait } from './browser.mjs';
import { BASE as HOST } from './target.mjs';

// `menu=0` because everything below measures the world, and the title screen
// gates the frame loop. No `fps=` cap: nothing here is a frame-edge assertion.
const URL = `${HOST}/?menu=0&vol=0`;

const QUEST = 'quest:land/first-light';
/** What the quest's own asset says, so the probe is not a second copy of it. */
const PRACTICE_THROWS = 3;

const browser = await launchBrowser();
const results = {};
const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); };

const page = await newPage(browser, { width: 1280, height: 800 });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(
  () => window.__dbgBoot && window.__dbgBoot().playing && window.__dbgJournal,
  { timeout: 60000 },
);
await wait(200);

const dbg = (fn, ...args) => page.evaluate(fn, ...args);
/** The content facts, which is what every claim below is really about. */
const state = () => dbg(async () => {
  const { content } = await import('/src/content/index.ts');
  const id = 'quest:land/first-light';
  return {
    status: content.state.questStatus(id),
    talk: content.state.progress(id, 'talk-to-gain'),
    practice: content.state.progress(id, 'bond-practice'),
    flags: content.state.flags.slice(),
    discovered: content.state.discovered('town:encampment'),
  };
});
const journal = () => dbg(() => window.__dbgJournal().model);
const purse = () => dbg(() => window.__dbgZone().shards);
const orbs = () => dbg(() => {
  const row = window.__dbgZone().bag.find((b) => b.id === 'orb-tame');
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
  if (!who) return null;
  await dbg((n) => window.__dbgTp(n.x + 2, n.z), who);
  await wait(300);
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('KeyE');
    await wait(200);
    const talking = (await dbg(() => window.__dbgNpcs())).talking;
    if (talking?.id === id) return talking.line;
  }
  return null;
}

/** Dismiss the one-line dialogue panel so the next press opens a new one. */
async function endTalk() {
  await page.keyboard.press('Escape');
  await wait(250);
}

// ---------- 1. the campaign has exactly one entry point ---------------------
{
  const model = await journal();
  const main = model.filter((e) => e.category === 'main');
  const offered = main.filter((e) => e.tab === 'available').map((e) => e.id);
  results.entryPoint = {
    mainQuests: main.map((e) => ({ id: e.id, tab: e.tab })),
    offered,
    state: await state(),
  };
  check(offered.includes(QUEST), `${QUEST} is not offered on a fresh character: ${JSON.stringify(offered)}`);
  check(offered.length === 1,
    `${offered.length} main quests are offered at boot, not 1: ${JSON.stringify(offered)}`);
  check(results.entryPoint.state.status === 'unknown',
    `the opening quest starts at "${results.entryPoint.state.status}", not untouched`);
}

// ---------- 2. talking to Gain starts it ------------------------------------
{
  const line = await talkTo('gain');
  await endTalk();
  const s = await state();
  results.offer = { line, ...s, orbs: await orbs() };
  check(line !== null, 'could not get a word out of Gain');
  check(s.status === 'active', `the quest is "${s.status}" after talking to its giver`);
  check(s.talk === 1, `talk-to-gain is ${s.talk} after one conversation, not 1`);
  // `onStart` hands over the practice orbs, which is the lifecycle runner doing
  // its job: nothing but a status change happened, and an action list ran.
  check(results.offer.orbs >= PRACTICE_THROWS,
    `only ${results.offer.orbs} taming orbs after the quest started — onStart did not pay out`);
}

// ---------- 3. there is something to practise on ----------------------------
{
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await wait(250);
    target = (await dbg(() => window.__dbgTaming('wild-sproutle'))).target;
  }
  results.practiceBeast = target;
  check(target !== null,
    'no wild Sproutle was staged for the practice — a throw at nothing is refused '
    + 'before the orb leaves the hand, so the objective could never tick');
}

// ---------- 4. three throws, and a fourth that changes nothing --------------
{
  const throws = [];
  for (let i = 0; i < PRACTICE_THROWS + 1; i++) {
    // A settling orb refuses the next throw (`busy`), so wait out the ceremony
    // rather than guessing at its length.
    for (let w = 0; w < 40; w++) {
      if (!(await dbg(() => window.__dbgTaming())).bonding) break;
      await wait(250);
    }
    // `false` BREAKS the orb on purpose. The objective counts the throw and not
    // the catch, and a rolled outcome would make this a test that fails one run
    // in however-many.
    throws.push(await dbg(() => window.__dbgThrowOrb('wild-sproutle', false)));
    await wait(400);
  }
  const s = await state();
  results.practice = { throws: throws.map((t) => t.outcome), progress: s.practice };
  check(throws.slice(0, PRACTICE_THROWS).every((t) => t.outcome === 'thrown'),
    `a practice throw was refused: ${JSON.stringify(results.practice.throws)}`);
  check(s.practice === PRACTICE_THROWS,
    `bond-practice is ${s.practice} after ${PRACTICE_THROWS + 1} throws, not capped at ${PRACTICE_THROWS}`);
}

// ---------- 5. the turn-in pays and sets ------------------------------------
{
  const before = await purse();
  const line = await talkTo('gain');
  await endTalk();
  const s = await state();
  const after = await purse();
  results.turnIn = {
    line, status: s.status, flags: s.flags, discovered: s.discovered,
    shardsBefore: before, shardsAfter: after,
  };
  check(s.status === 'completed', `the quest is "${s.status}" after the turn-in`);
  check(s.flags.includes('taming-learned'), 'taming-learned was not set');
  check(s.flags.includes('met-gain'), 'met-gain was not set');
  check(s.discovered === true, 'town:encampment was not discovered');
  check(after - before === 10,
    `the reward paid ${after - before} Cubloons, not the 10 the quest promises`);
}

console.log(JSON.stringify(results, null, 2));
if (fails.length) {
  console.error(`\n${fails.length} failure(s):`);
  for (const f of fails) console.error(`  ${f}`);
}
await browser.close();
process.exit(fails.length ? 1 : 0);
