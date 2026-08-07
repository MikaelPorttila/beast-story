// Verifies the F3 Debug panel's spawner (src/ui/perf-panel.ts's lower half,
// src/core/spawn.ts, src/world/spawned.ts): the tree, the search box over it,
// and that a click on a row actually puts the thing in the world.
//
// Usage: bun tools/test-spawn.mjs        (dev server must be up)
//
// EVERY BRANCH IS ASSERTED ON WHAT THE WORLD DID, not on what the panel said.
// The spawner returns a sentence per click and a probe that read only that
// would pass against a version where the sentence is the whole feature — so an
// item is judged by the bag, a beast by the bonded set, an enemy by the live
// enemy count and a structure by the COLLIDER standing where it was placed.
//
// THE STRUCTURE SECTION IS THE PAIR that matters most. "A hut appeared" is
// equally true of a mesh you can walk straight through, which is the failure
// mode this whole file exists to catch — the world had no runtime placement
// path before this feature, and the easy way to add one is to stamp the mesh
// and forget the field. So it asserts a box near the spot AND that clearing
// takes it away again, because a spawner that only accumulates is a leak
// wearing a feature's clothes.
//
// THE SEARCH BOX IS ALSO A PAIR, for the reason AGENTS.md gives: "typing
// filtered the list" is only worth something beside "and the hero did not
// strafe while I typed it". `WASD` are letters and this panel is deliberately
// not a modal, so the second half is the whole risk.
//
// menu=0: this measures the world, so it needs the frame loop running.
//
// Exits non-zero.
import { launchBrowser, newPage, wait } from './browser.mjs';
import { BASE as HOST } from './target.mjs';

const browser = await launchBrowser();
const page = await newPage(browser, { width: 1280, height: 900 });
page.on('pageerror', (e) => console.error('[page]', e.message));
await page.goto(`${HOST}/?menu=0&vol=0&fs=0`, { waitUntil: 'load' });
await page.waitForFunction(() => typeof window.__dbgSpawn === 'function', { timeout: 60000 });
await page.waitForFunction(() => window.__dbgBoot?.().playing === true, { timeout: 60000 });

const results = {};
const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); };

const read = () => page.evaluate(() => window.__dbgSpawn());
const doSpawn = (b, r) => page.evaluate(([x, y]) => window.__dbgSpawn(x, y), [b, r]);
const bagCount = (id) => page.evaluate(
  (i) => (window.__dbgInventory().bag.find((e) => e.id === i)?.count ?? 0), id);
/**
 * Colliders within 20 m of the hero — a spawn lands at 8 (see `SPAWN_AHEAD` in
 * main.ts), and the query is around HIM rather than around the computed spot
 * because his facing is not on the probe surface and a delta does not need it.
 * The camp's own boxes are inside this radius too, which is exactly why every
 * assertion below is a CHANGE and never an absolute count.
 */
const boxesNear = () => page.evaluate(() => {
  const p = window.__dbgPlayerPos();
  return window.__dbgStructures(p.x, p.z, 20).length;
});
/**
 * Click something in the panel, having first scrolled it into the body's view.
 *
 * `.bs-perf-body` is the scroller (the panel itself must not be — see the note
 * in ui/perf-panel.ts), and with four branches expanded its content is taller
 * than the panel: a row below the fold has a box the page can see and a point
 * puppeteer refuses, because the point is outside the clipped area. Scrolling
 * first is what a person does too.
 */
const clickEl = async (sel) => {
  await page.$eval(sel, (e) => e.scrollIntoView({ block: 'center' }));
  try {
    await page.click(sel);
  } catch (err) {
    const box = await page.$eval(sel, (e) => {
      const r = e.getBoundingClientRect();
      return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
    }).catch(() => null);
    throw new Error(`click ${sel} failed (box ${JSON.stringify(box)}): ${err.message}`);
  }
};
/** The row ids the panel is actually offering under one branch. */
const rowIds = (branch) => page.$$eval(`.bs-spawn-row[data-branch="${branch}"]`,
  (n) => n.map((e) => e.dataset.row));
const setSearch = async (text) => {
  await clickEl('.bs-spawn-search');
  await page.evaluate(() => { document.querySelector('.bs-spawn-search').value = ''; });
  if (text) await page.keyboard.type(text);
  await page.evaluate(() => document.querySelector('.bs-spawn-search')
    .dispatchEvent(new Event('input', { bubbles: true })));
  await wait(60);
};

// ---------- 1. the panel opens, and it is called Debug -----------------------
// The rename is a one-word change and exactly the kind that is made in the
// English table and forgotten in the panel that reads it, so it is asserted on
// the rendered title rather than on the key.
{
  await page.keyboard.press('F3');
  await page.waitForSelector('.bs-perf', { visible: true, timeout: 5000 });
  const title = await page.$eval('.bs-perf-title', (e) => e.textContent.trim());
  results.title = title;
  check(title === 'Debug', `the panel title is "${title}", expected "Debug"`);
  const hasSearch = await page.$('.bs-spawn-search') !== null;
  const branches = await page.$$eval('.bs-spawn-branch', (n) => n.map((e) => e.dataset.branch));
  results.branches = branches;
  check(hasSearch, 'no search box in the panel');
  check(['items', 'beasts', 'enemies', 'structures'].every((b) => branches.includes(b)),
    `the tree is missing a branch: ${JSON.stringify(branches)}`);
  // Collapsed by default: with ninety rows open the renderer switches above
  // would be off the top of the panel the moment it opened.
  const leaves = await page.$$eval('.bs-spawn-row', (n) => n.length);
  results.leavesCollapsed = leaves;
  check(leaves === 0, `${leaves} rows are showing with every branch collapsed`);
}

// ---------- 2. a branch expands, and the search narrows it -------------------
{
  await clickEl('.bs-spawn-branch[data-branch="items"]');
  const all = (await rowIds('items')).length;
  await setSearch('potion');
  const rows = await rowIds('items');
  results.search = { allItems: all, matched: rows };
  check(all > 10, `only ${all} item rows expanded — the catalogue should be far larger`);
  check(rows.length > 0 && rows.length < all,
    `"potion" matched ${rows.length} of ${all} rows — it should narrow, not clear or keep everything`);
  check(rows.every((id) => id.includes('potion')),
    `"potion" matched something that is not one: ${JSON.stringify(rows)}`);
}

// ---------- 3. ...and the hero did not walk while it was typed ---------------
// The other half of section 2, and the reason the search box needed a capture
// listener at all. `potion` contains no movement key, so this types the ones
// that ARE — and then a control: the same keys with the field blurred DO move
// him, or this section would pass against a game with the hero switched off.
{
  const before = await page.evaluate(() => window.__dbgPlayerPos());
  const typingFlag = (await read()).typing;
  // HELD, not typed: a keystroke that is swallowed leaves nothing down, and a
  // tap of W would move him a few centimetres even in a correct build. The keys
  // go down, a second and a half of simulated time passes, and they come up.
  for (const k of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) await page.keyboard.down(k);
  await page.evaluate(() => window.__dbgAdvance(1.5));
  for (const k of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) await page.keyboard.up(k);
  const held = await page.evaluate(() => window.__dbgPlayerPos());
  const typedMove = Math.hypot(held.x - before.x, held.z - before.z);

  // Escape leaves the field. Then hold W for the same simulated span with
  // nothing focused: the control, without which this section proves nothing.
  await page.keyboard.press('Escape');
  await wait(60);
  await page.keyboard.down('KeyW');
  await page.evaluate(() => window.__dbgAdvance(1.5));
  await page.keyboard.up('KeyW');
  const after = await page.evaluate(() => window.__dbgPlayerPos());
  const freeMove = Math.hypot(after.x - held.x, after.z - held.z);

  results.typing = {
    typed: +typedMove.toFixed(3), free: +freeMove.toFixed(3), typingFlag,
    blurred: (await read()).typing,
  };
  check(typingFlag === true, 'the panel did not report itself as typing with the field focused');
  check(results.typing.blurred === false, 'Escape did not leave the search field');
  check(typedMove < 0.5, `the hero moved ${typedMove.toFixed(2)} m while WASD was typed into the search box`);
  check(freeMove > 2, `the control hold moved him only ${freeMove.toFixed(2)} m — this section proves nothing`);
}

// ---------- 4. items land in the bag -----------------------------------------
{
  await setSearch('');
  const before = await bagCount('potion-mend');
  const said = await doSpawn('items', 'potion-mend');
  const after = await bagCount('potion-mend');
  results.items = { said, before, after };
  check(after === before + 1, `the bag went ${before} -> ${after} for one spawned potion`);
  const bad = await doSpawn('items', 'no-such-item');
  check(/no such item/.test(bad), `an unknown id answered "${bad}"`);
}

// ---------- 5. beasts bond ---------------------------------------------------
{
  const before = await page.evaluate(() => window.__dbgTaming().owned.length);
  await doSpawn('beasts', 'emberfox');
  const owned = await page.evaluate(() => window.__dbgTaming().owned);
  results.beasts = { before, owned };
  check(owned.includes('emberfox'), `emberfox is not bonded after a spawn: ${JSON.stringify(owned)}`);
  // The row is marked, which is what the greyed style is drawn from — and the
  // marking is re-derived per draw, so this also says the tree is not cached.
  await clickEl('.bs-spawn-branch[data-branch="beasts"]');
  const had = await page.$$eval('.bs-spawn-row[data-branch="beasts"]',
    (n) => n.filter((e) => e.classList.contains('had')).map((e) => e.dataset.row));
  results.beastsHad = had;
  check(had.includes('emberfox'), 'the bonded beast\'s row is not marked as already had');
  await clickEl('.bs-spawn-branch[data-branch="beasts"]');
}

// ---------- 6. enemies arrive in the world -----------------------------------
// The id comes off the PANEL rather than out of core.json, so this cannot pass
// against a tree that offers ids the spawner does not accept — which is the one
// way a name-keyed catalogue goes wrong.
{
  await clickEl('.bs-spawn-branch[data-branch="enemies"]');
  const ids = await rowIds('enemies');
  const before = (await read()).enemies;
  const said = await doSpawn('enemies', ids[0]);
  const after = (await read()).enemies;
  results.enemies = { offered: ids, spawned: ids[0], said, before, after };
  check(ids.length > 0, 'the enemy branch offers nothing');
  check(after === before + 1, `the wild population went ${before} -> ${after} for one spawned enemy`);
  await clickEl('.bs-spawn-branch[data-branch="enemies"]');
}

// ---------- 7. a structure is BUILT, not drawn -------------------------------
// The pair described at the top. `hut-a` is chosen because it has both a box
// and a roof cylinder, so the two debug views are exercised at once.
{
  const before = await boxesNear();
  const said = await doSpawn('structures', 'hut-a');
  const after = await boxesNear();
  const standing = (await read()).structures;
  results.structures = { said, boxesBefore: before, boxesAfter: after, standing };
  check(standing === 1, `${standing} structures standing after one spawn`);
  check(after > before, `no collider appeared where the hut was placed (${before} -> ${after})`);

  const cleared = await doSpawn('structures', '*clear');
  const back = await boxesNear();
  results.cleared = { cleared, boxes: back, standing: (await read()).structures };
  check(results.cleared.standing === 0, 'clearing left structures standing');
  check(back === before, `clearing left ${back - before} collider(s) behind`);

  const bad = await doSpawn('structures', 'no-such-part');
  check(/nothing named/.test(bad), `an unknown part answered "${bad}"`);
}

console.log(JSON.stringify({ ...results, failures: fails, pass: fails.length === 0 }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
