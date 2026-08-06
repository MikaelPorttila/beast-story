// The quest journal (issue #98): the panel `J` opens, and the HUD tracker the
// switch inside it drives.
//
// Usage: bun tools/test-journal.mjs      (dev server must be up)
//
// STANDALONE, NOT A SUITE SECTION, and the reason is state rather than timing.
// `core` ships no quests, so this probe has to LOAD `example-quest` and set it
// active to have anything to look at — and that quest carries `timeOfDay: 0`,
// which pins the world clock to midnight for as long as it is active (see
// `refreshQuestTime` in main.ts). A module that leaves the sky black is not a
// module that can share a page with `gfx` or `daynight`. Its own page, its own
// mess, gone when the browser closes.
//
// FOUR CLAIMS, and three of them are PAIRS for the reason every probe in here
// that says so gives — one arm alone passes against a broken build:
//
//   1. `J` OPENS IT, AND THE HERO IS FROZEN WHILE IT IS UP. "The panel appeared"
//      is equally true of a modal and of a picture drawn over a hero still
//      walking into a lake. Travel with it up must be 0 and the identical hold
//      with it down must move him, or the 0 is a hero who could not walk anyway.
//   2. A STAGED QUEST REACHES THE SCREEN. Not "the model has one" — the card,
//      its objective lines and its reward chips are counted on the DOM, because
//      a model that is right and a panel that is empty is the failure this
//      hook's `panel` field exists to make visible.
//   3. THE SWITCH MOVES THE HUD AND NOT THE QUEST. Off empties the tracker; on
//      brings it back; and the quest is STILL ACTIVE either way. Without that
//      third reading, "the tracker is empty" passes for a button that abandons
//      the quest, which is the one thing it must never be mistaken for.
//   4. A TAB IS A FILTER. The card is under Active and the empty state is under
//      Done, in the same run. "Done is empty" alone is equally true of a panel
//      that renders nothing at all.
//
// Exits non-zero on failure.
import { launchBrowser, newPage, wait } from './browser.mjs';
import { BASE as HOST } from './target.mjs';

// No `fps=` cap: nothing here is a frame-edge measurement, and the hold below is
// simulated rather than clocked.
const URL = `${HOST}/?menu=0&vol=0`;

const QUEST = 'quest:encampment/first-steps';

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const read = (page) => page.evaluate(() => window.__dbgJournal());
const pos = (page) => page.evaluate(() => window.__dbgPlayerPos());
const adv = (page, s) => page.evaluate(async (sec) => {
  const out = window.__dbgAdvance(sec);
  await new Promise((resv) => requestAnimationFrame(() => requestAnimationFrame(resv)));
  return out;
}, s);
/** One REAL frame. `J` is read frame-side (takePress), so the press needs one. */
const frame = (page) => page.evaluate(
  () => new Promise((resv) => requestAnimationFrame(() => requestAnimationFrame(resv))));

async function toggle(page, wantOpen) {
  await page.keyboard.press('KeyJ');
  await frame(page);
  await page.waitForFunction(
    (want) => window.__dbgJournal().open === want, { timeout: 5000 }, wantOpen,
  ).catch(() => {});
}

const results = {};
const browser = await launchBrowser();
const page = await newPage(browser, { width: 1280, height: 800 });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(
  () => window.__dbgBoot && window.__dbgBoot().playing && window.__dbgAdvance,
  { timeout: 60000 },
);
await wait(200);

// ---------- 1. nothing staged: the panel opens and says so ------------------
// The EMPTY STATE is worth an assertion of its own: it is what every player sees
// until content ships a quest, and a panel that renders nothing at all when it
// has nothing to show looks identical to one that failed to open.
await toggle(page, true);
{
  const j = await read(page);
  results.empty = {
    open: j.open,
    tab: j.tab,
    tabs: j.panel?.tabs ?? 0,
    emptyState: j.panel?.empty ?? false,
    cards: j.panel?.cards ?? [],
    hudQuests: j.hud.quests.length,
  };
}

// ---------- 2. the modal pair ----------------------------------------------
// The hold is SIMULATED: a held key stays held through `adv`, and the modal
// suspends the input in exactly those slices — which is the claim being made.
// The controller still RUNS behind the panel (issue #101); 0 travel is the
// sticks being at rest, not the clock stopping.
{
  const hold = async (simS) => {
    const a = await pos(page);
    await page.keyboard.down('KeyW');
    await adv(page, simS);
    await page.keyboard.up('KeyW');
    await adv(page, 0.12);
    return dist(a, await pos(page));
  };
  const travelOpen = await hold(1.2);
  await toggle(page, false);
  const travelShut = await hold(1.2);
  results.modal = {
    travelOpen: +travelOpen.toFixed(2),
    travelShut: +travelShut.toFixed(2),
  };
}

// ---------- 3. stage a quest, and look at the card --------------------------
const staged = await page.evaluate(() => window.__dbgQuestStage());
await frame(page);
await toggle(page, true);
{
  const j = await read(page);
  const card = j.model.find((q) => q.id === QUEST) ?? null;
  results.card = {
    staged,
    tab: card?.tab ?? null,
    category: card?.category ?? null,
    name: card?.name ?? null,
    objectives: card?.objectives ?? [],
    rewards: card?.rewards ?? [],
    onHud: card?.onHud ?? null,
    // What actually reached the DOM.
    drawn: j.panel?.cards ?? [],
    steps: j.panel?.steps ?? 0,
    rewardChips: j.panel?.rewards ?? 0,
    hudButtons: j.panel?.hudButtons ?? 0,
    // OPT-OUT: a quest the player has never touched is already on the tracker.
    hudQuests: j.hud.quests,
    hudSteps: j.hud.steps,
  };
}

// ---------- 4. the switch: the HUD moves, the quest does not ----------------
{
  const off = await page.evaluate((id) => window.__dbgJournalHud(id), QUEST);
  await frame(page);
  const afterOff = await read(page);
  const on = await page.evaluate((id) => window.__dbgJournalHud(id), QUEST);
  await frame(page);
  const afterOn = await read(page);
  const still = (j) => (j.model.find((q) => q.id === QUEST)?.tab ?? null);
  results.hudSwitch = {
    off,
    hudAfterOff: afterOff.hud.quests.length,
    tabAfterOff: still(afterOff),
    pressedAfterOff: afterOff.panel?.hudOn ?? null,
    on,
    hudAfterOn: afterOn.hud.quests.length,
    tabAfterOn: still(afterOn),
    pressedAfterOn: afterOn.panel?.hudOn ?? null,
  };
}

// ---------- 5. a tab is a filter -------------------------------------------
{
  await page.evaluate(() => {
    const done = [...document.querySelectorAll('.bs-journal .chip.tab')]
      .find((b) => b.dataset.tab === 'completed');
    done?.click();
  });
  await frame(page);
  const j = await read(page);
  results.tabs = {
    tab: j.tab,
    cards: j.panel?.cards ?? [],
    emptyState: j.panel?.empty ?? false,
  };
  // Back to Active, so the Escape check below closes a panel in a known state.
  await page.evaluate(() => {
    const act = [...document.querySelectorAll('.bs-journal .chip.tab')]
      .find((b) => b.dataset.tab === 'active');
    act?.click();
  });
  await frame(page);
}

// ---------- 6. Escape closes it --------------------------------------------
// The other half of the key contract: `J` toggles, and the cancel branch in
// main.ts spends one press on the topmost modal.
{
  await page.keyboard.press('Escape');
  await adv(page, 0.1);
  await page.waitForFunction(() => !window.__dbgJournal().open, { timeout: 5000 }).catch(() => {});
  results.escape = { open: (await read(page)).open };
}

console.log(JSON.stringify(results, null, 2));
await browser.close();

// ---------------------------------------------------------------------------
// What has to be true
// ---------------------------------------------------------------------------
const fail = [];
const check = (ok, what) => { if (!ok) fail.push(what); };

check(results.empty.open === true, 'J did not open the journal');
check(results.empty.tabs === 3, `expected 3 tabs, drew ${results.empty.tabs}`);
check(results.empty.emptyState === true,
  'with no quests loaded the panel drew no empty state');
check(results.empty.hudQuests === 0, 'the HUD tracker had rows before any quest existed');

check(results.modal.travelOpen === 0,
  `the hero walked ${results.modal.travelOpen} units with the journal up — it is not a modal`);
check(results.modal.travelShut > 1,
  `the control hold moved him only ${results.modal.travelShut} units, so the 0 above proves nothing`);

check(results.card.staged?.quests?.includes(QUEST) === true,
  `staging did not load ${QUEST}: ${JSON.stringify(results.card.staged)}`);
check(results.card.tab === 'active', `the staged quest is on "${results.card.tab}", not active`);
check(results.card.category === 'main', `expected a main quest, got "${results.card.category}"`);
check(!!results.card.name && !results.card.name.startsWith('['),
  `the quest name did not resolve: ${results.card.name}`);
check(results.card.objectives.length === 1,
  `expected 1 objective, model has ${results.card.objectives.length}`);
check(results.card.rewards.length === 2,
  `expected 2 rewards, model has ${results.card.rewards.length}`);
// The DOM half. A model that is right and a panel that is empty is the failure
// these three exist to catch.
check(results.card.drawn.includes(QUEST),
  `the card never reached the DOM: ${JSON.stringify(results.card.drawn)}`);
check(results.card.steps === 1, `the card drew ${results.card.steps} objective lines, expected 1`);
check(results.card.rewardChips === 2,
  `the card drew ${results.card.rewardChips} reward chips, expected 2`);
check(results.card.hudButtons === 1,
  `an active quest drew ${results.card.hudButtons} HUD switches, expected 1`);
check(results.card.onHud === true, 'a fresh quest was not on the HUD — the switch is opt-OUT');
check(results.card.hudQuests.length === 1,
  `the tracker shows ${results.card.hudQuests.length} quests, expected 1`);
check(results.card.hudSteps === 1,
  `the tracker drew ${results.card.hudSteps} step lines, expected 1`);

check(results.hudSwitch.off === false, 'the switch did not report itself off');
check(results.hudSwitch.hudAfterOff === 0,
  `the tracker still had ${results.hudSwitch.hudAfterOff} rows after switching off`);
check(results.hudSwitch.pressedAfterOff === 0,
  'the button still drew itself as pressed after switching off');
check(results.hudSwitch.tabAfterOff === 'active',
  `switching off the HUD moved the quest to "${results.hudSwitch.tabAfterOff}" — it must only `
  + 'change what is DRAWN');
check(results.hudSwitch.on === true, 'the switch did not come back on');
check(results.hudSwitch.hudAfterOn === 1,
  `the tracker had ${results.hudSwitch.hudAfterOn} rows after switching back on, expected 1`);
check(results.hudSwitch.pressedAfterOn === 1,
  'the button did not draw itself as pressed after switching back on');
check(results.hudSwitch.tabAfterOn === 'active', 'the quest left active after switching back on');

check(results.tabs.tab === 'completed', `the Done tab did not take: on "${results.tabs.tab}"`);
check(results.tabs.cards.length === 0,
  `the Done tab drew ${results.tabs.cards.length} cards for an active quest`);
check(results.tabs.emptyState === true, 'the Done tab drew no empty state');

check(results.escape.open === false, 'Escape did not close the journal');

if (fail.length) {
  console.error(`\n${fail.length} failure(s):\n  ${fail.join('\n  ')}`);
  process.exit(1);
}
console.log('\nOK');
