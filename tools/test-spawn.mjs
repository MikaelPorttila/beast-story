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
// SO IS THE WHEEL, and so is the AIM. A scroll over the tree must leave the
// camera alone while the same gesture over the world moves it; and the spot a
// spawn lands on must be where the crosshair ray meets the ground, marched
// independently here off `__dbgCam().dir` and then checked again by zooming out
// — which moves the lens, and nothing about where the hero is standing.
//
// menu=0: this measures the world, so it needs the frame loop running.
//
// Exits non-zero.
import { launchBrowser, newPage, wait } from "./browser.mjs";
import { BASE as HOST } from "./target.mjs";

const browser = await launchBrowser();
const page = await newPage(browser, { width: 1280, height: 900 });
page.on("pageerror", (e) => console.error("[page]", e.message));
await page.goto(`${HOST}/?menu=0&vol=0&fs=0`, { waitUntil: "load" });
await page.waitForFunction(() => typeof window.__dbgSpawn === "function", { timeout: 60000 });
await page.waitForFunction(() => window.__dbgBoot?.().playing === true, { timeout: 60000 });

const results = {};
const fails = [];
const check = (ok, msg) => {
  if (!ok) {
    fails.push(msg);
  }
};

const read = () => page.evaluate(() => window.__dbgSpawn());
const doSpawn = (b, r) => page.evaluate(([x, y]) => window.__dbgSpawn(x, y), [b, r]);
const bagCount = (id) =>
  page.evaluate((i) => window.__dbgInventory().bag.find((e) => e.id === i)?.count ?? 0, id);
/**
 * Colliders within 20 m of the hero. A spawn lands under the crosshair, which
 * from the default framing is fifteen-odd metres out (see `spawnSpot` in
 * main.ts), so the ring is drawn around HIM and made generous rather than
 * chased to the exact point — section 8 is where the exact point is asserted.
 * The camp's own boxes are inside this radius too, which is exactly why every
 * assertion using it is a CHANGE and never an absolute count.
 */
const boxesNear = () =>
  page.evaluate(() => {
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
  await page.$eval(sel, (e) => e.scrollIntoView({ block: "center" }));
  try {
    await page.click(sel);
  } catch (err) {
    const box = await page
      .$eval(sel, (e) => {
        const r = e.getBoundingClientRect();
        return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
      })
      .catch(() => null);
    throw new Error(`click ${sel} failed (box ${JSON.stringify(box)}): ${err.message}`, {
      cause: err,
    });
  }
};
/** The row ids the panel is actually offering under one branch. */
const rowIds = (branch) =>
  page.$$eval(`.bs-spawn-row[data-branch="${branch}"]`, (n) => n.map((e) => e.dataset.row));
const setSearch = async (text) => {
  await clickEl(".bs-spawn-search");
  await page.evaluate(() => {
    document.querySelector(".bs-spawn-search").value = "";
  });
  if (text) {
    await page.keyboard.type(text);
  }
  await page.evaluate(() =>
    document.querySelector(".bs-spawn-search").dispatchEvent(new Event("input", { bubbles: true })),
  );
  await wait(60);
};

// ---------- 1. the panel opens, and it is called Debug -----------------------
// The rename is a one-word change and exactly the kind that is made in the
// English table and forgotten in the panel that reads it, so it is asserted on
// the rendered title rather than on the key.
{
  await page.keyboard.press("F3");
  await page.waitForSelector(".bs-perf", { visible: true, timeout: 5000 });
  const title = await page.$eval(".bs-perf-title", (e) => e.textContent.trim());
  results.title = title;
  check(title === "Debug", `the panel title is "${title}", expected "Debug"`);
  const hasSearch = (await page.$(".bs-spawn-search")) !== null;
  const branches = await page.$$eval(".bs-spawn-branch", (n) => n.map((e) => e.dataset.branch));
  results.branches = branches;
  check(hasSearch, "no search box in the panel");
  check(
    ["items", "beasts", "enemies", "structures"].every((b) => branches.includes(b)),
    `the tree is missing a branch: ${JSON.stringify(branches)}`,
  );
  // Collapsed by default: with ninety rows open the renderer switches above
  // would be off the top of the panel the moment it opened.
  const leaves = await page.$$eval(".bs-spawn-row", (n) => n.length);
  results.leavesCollapsed = leaves;
  check(leaves === 0, `${leaves} rows are showing with every branch collapsed`);
}

// ---------- 2. a branch expands, and the search narrows it -------------------
{
  await clickEl('.bs-spawn-branch[data-branch="items"]');
  const all = (await rowIds("items")).length;
  await setSearch("potion");
  const rows = await rowIds("items");
  results.search = { allItems: all, matched: rows };
  check(all > 10, `only ${all} item rows expanded — the catalogue should be far larger`);
  check(
    rows.length > 0 && rows.length < all,
    `"potion" matched ${rows.length} of ${all} rows — it should narrow, not clear or keep everything`,
  );
  check(
    rows.every((id) => id.includes("potion")),
    `"potion" matched something that is not one: ${JSON.stringify(rows)}`,
  );
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
  for (const k of ["KeyW", "KeyA", "KeyS", "KeyD"]) {
    await page.keyboard.down(k);
  }
  await page.evaluate(() => window.__dbgAdvance(1.5));
  for (const k of ["KeyW", "KeyA", "KeyS", "KeyD"]) {
    await page.keyboard.up(k);
  }
  const held = await page.evaluate(() => window.__dbgPlayerPos());
  const typedMove = Math.hypot(held.x - before.x, held.z - before.z);

  // Escape leaves the field. Then hold W for the same simulated span with
  // nothing focused: the control, without which this section proves nothing.
  await page.keyboard.press("Escape");
  await wait(60);
  await page.keyboard.down("KeyW");
  await page.evaluate(() => window.__dbgAdvance(1.5));
  await page.keyboard.up("KeyW");
  const after = await page.evaluate(() => window.__dbgPlayerPos());
  const freeMove = Math.hypot(after.x - held.x, after.z - held.z);

  results.typing = {
    typed: +typedMove.toFixed(3),
    free: +freeMove.toFixed(3),
    typingFlag,
    blurred: (await read()).typing,
  };
  check(typingFlag === true, "the panel did not report itself as typing with the field focused");
  check(results.typing.blurred === false, "Escape did not leave the search field");
  check(
    typedMove < 0.5,
    `the hero moved ${typedMove.toFixed(2)} m while WASD was typed into the search box`,
  );
  check(
    freeMove > 2,
    `the control hold moved him only ${freeMove.toFixed(2)} m — this section proves nothing`,
  );
}

// ---------- 4. items land in the bag -----------------------------------------
{
  await setSearch("");
  const before = await bagCount("potion-mend");
  const said = await doSpawn("items", "potion-mend");
  const after = await bagCount("potion-mend");
  results.items = { said, before, after };
  check(after === before + 1, `the bag went ${before} -> ${after} for one spawned potion`);
  const bad = await doSpawn("items", "no-such-item");
  check(/no such item/.test(bad), `an unknown id answered "${bad}"`);
}

// ---------- 5. beasts bond ---------------------------------------------------
{
  const before = await page.evaluate(() => window.__dbgTaming().owned.length);
  await doSpawn("beasts", "emberfox");
  const owned = await page.evaluate(() => window.__dbgTaming().owned);
  results.beasts = { before, owned };
  check(
    owned.includes("emberfox"),
    `emberfox is not bonded after a spawn: ${JSON.stringify(owned)}`,
  );
  // The row is marked, which is what the greyed style is drawn from — and the
  // marking is re-derived per draw, so this also says the tree is not cached.
  await clickEl('.bs-spawn-branch[data-branch="beasts"]');
  const had = await page.$$eval('.bs-spawn-row[data-branch="beasts"]', (n) =>
    n.filter((e) => e.classList.contains("had")).map((e) => e.dataset.row),
  );
  results.beastsHad = had;
  check(had.includes("emberfox"), "the bonded beast's row is not marked as already had");
  await clickEl('.bs-spawn-branch[data-branch="beasts"]');
}

// ---------- 6. enemies arrive in the world -----------------------------------
// The id comes off the PANEL rather than out of core.json, so this cannot pass
// against a tree that offers ids the spawner does not accept — which is the one
// way a name-keyed catalogue goes wrong.
{
  await clickEl('.bs-spawn-branch[data-branch="enemies"]');
  const ids = await rowIds("enemies");
  const before = (await read()).enemies;
  const said = await doSpawn("enemies", ids[0]);
  const after = (await read()).enemies;
  results.enemies = { offered: ids, spawned: ids[0], said, before, after };
  check(ids.length > 0, "the enemy branch offers nothing");
  check(
    after === before + 1,
    `the wild population went ${before} -> ${after} for one spawned enemy`,
  );
  await clickEl('.bs-spawn-branch[data-branch="enemies"]');
}

// ---------- 7. a structure is BUILT, not drawn -------------------------------
// The pair described at the top. `hut-a` is chosen because it has both a box
// and a roof cylinder, so the two debug views are exercised at once.
{
  const before = await boxesNear();
  const said = await doSpawn("structures", "hut-a");
  const after = await boxesNear();
  const standing = (await read()).structures;
  results.structures = { said, boxesBefore: before, boxesAfter: after, standing };
  check(standing === 1, `${standing} structures standing after one spawn`);
  check(after > before, `no collider appeared where the hut was placed (${before} -> ${after})`);

  const cleared = await doSpawn("structures", "*clear");
  const back = await boxesNear();
  results.cleared = { cleared, boxes: back, standing: (await read()).structures };
  check(results.cleared.standing === 0, "clearing left structures standing");
  check(back === before, `clearing left ${back - before} collider(s) behind`);

  const bad = await doSpawn("structures", "no-such-part");
  check(/nothing named/.test(bad), `an unknown part answered "${bad}"`);
}

// ---------- 8. it lands where the CROSSHAIR points ---------------------------
// Two claims. The spot the panel names has to be the point where the camera's
// own forward meets the ground — marched here INDEPENDENTLY off `__dbgCam().dir`
// rather than read back off the thing under test — and the building has to
// actually arrive there.
//
// The march below is not the game's: it steps a plain 0.25 m and stops, where
// main.ts steps 0.5 and then bisects. Agreeing to within a metre across two
// different methods is the claim; agreeing exactly would only say the code was
// copied.
{
  const marched = await page.evaluate(() => {
    const c = window.__dbgCam();
    if (c.dir.y >= -0.02) {
      return null;
    }
    for (let d = 2; d <= 60; d += 0.25) {
      const x = c.x + c.dir.x * d;
      const z = c.z + c.dir.z * d;
      if (c.y + c.dir.y * d <= window.__dbgWorld(x, z).ground) {
        return { x, z, d };
      }
    }
    return null;
  });
  const s = await read();
  const said = await doSpawn("structures", "watchpost");
  const boxes = await page.evaluate(
    ([x, z]) => window.__dbgStructures(x, z, 6),
    [s.spot.x, s.spot.z],
  );
  const nearest = boxes.length
    ? Math.min(...boxes.map((b) => Math.hypot(b.x - s.spot.x, b.z - s.spot.z)))
    : null;
  const rayGap = marched ? Math.hypot(marched.x - s.spot.x, marched.z - s.spot.z) : null;
  results.crosshair = {
    said,
    spot: s.spot,
    ahead: s.ahead,
    marched,
    rayGap: rayGap === null ? null : +rayGap.toFixed(3),
    nearest: nearest === null ? null : +nearest.toFixed(3),
  };
  check(marched !== null, "the camera was not pointed at any ground — nothing below can run");
  check(
    rayGap !== null && rayGap < 1,
    `the spot is ${rayGap} m from where the crosshair ray meets the ground`,
  );
  check(
    nearest !== null && nearest < 3,
    `nothing was built within 3 m of the point the panel named (nearest ${nearest})`,
  );
  await doSpawn("structures", "*clear");
}

// ---------- 9. a quest is handed in from the panel ---------------------------
// THE ROW IS A TURN-IN, not a status flip, and both halves are asserted: the
// quest completes AND is paid for, because a row that only marked it done would
// leave a tester with a journal that says one thing and a world that says
// another. The counters are the third half — content reads them (a giver's
// dialogue tests an objective's count), so a finished quest with zeroes in it is
// a state no play can produce.
{
  await setSearch("");
  const factsOf = (id) =>
    page.evaluate((q) => {
      const doc = window.__dbgContent().state ?? {};
      return {
        status: doc.quests?.[q] ?? "unknown",
        progress: Object.entries(doc.progress ?? {}).filter(([k]) => k.startsWith(`${q}/`)),
        flags: doc.flags ?? [],
      };
    }, id);
  const shards = () => page.evaluate(() => window.__dbgZone().shards);

  // Whatever the campaign is offering right now, off the PANEL — so this cannot
  // pass against a tree offering ids the handler does not take, and it does not
  // go stale when Act 1 grows a quest.
  const row = await page.evaluate(() =>
    window.__dbgSpawn().branches.find((b) => b.id === "quests"),
  );
  const first = "quest:land/first-light";
  const before = { ...(await factsOf(first)), shards: await shards() };
  const said = await doSpawn("quests", first);
  const after = { ...(await factsOf(first)), shards: await shards() };
  results.quests = { rows: row?.rows ?? 0, said, before, after };
  check((row?.rows ?? 0) > 0, "the panel offers no quest to hand in");
  check(before.status !== "completed", `${first} was already completed before the row was clicked`);
  check(after.status === "completed", `${first} is "${after.status}" after the row was clicked`);
  // ITS OWN `onComplete` RAN: the flags are the quest's, not the panel's.
  check(after.flags.includes("taming-learned"), "the quest's own onComplete did not run");
  check(
    after.shards > before.shards,
    `the turn-in paid ${after.shards - before.shards} Cubloons — the row marked it done and nothing else`,
  );
  check(
    after.progress.length > 0 && after.progress.every(([, n]) => n > 0),
    `the objectives were left unfilled: ${JSON.stringify(after.progress)}`,
  );
  const bad = await doSpawn("quests", "quest:no-such-quest");
  check(/nothing named that/.test(bad), `an unknown quest id answered "${bad}"`);
}

// ---------- 10. a wheel over the panel does not move the camera --------------
// The pair again: scrolling the tree must leave the lens alone, and the same
// gesture over the world must move it, or a game with zoom broken outright
// would pass the first half.
{
  const dist = () =>
    page.evaluate(() => {
      const c = window.__dbgCam();
      const p = window.__dbgPlayerPos();
      return Math.hypot(c.x - p.x, c.y - p.y, c.z - p.z);
    });
  await clickEl('.bs-spawn-branch[data-branch="items"]');
  const box = await page.$eval(".bs-spawn-tree", (e) => {
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 20) };
  });
  /**
   * Advance until the camera distance STOPS MOVING, and report where it stopped.
   *
   * A FIXED ADVANCE IS THE WRONG INSTRUMENT HERE, and this section is the proof.
   * It used to be one `__dbgAdvance(1.5)` with a comment reasoning that the ease
   * runs at lambda 8 so 1.5 s must be plenty. Measured, it is not: after the
   * control gesture the reading is 14.219 at one advance and 16.009 at the next,
   * WITH NO INPUT IN BETWEEN — and 1.79 m is exactly the "leak" this section
   * reported. The two readings were two points on the same settling curve.
   *
   * It is not simply a slow ease either: the same 1.5 s taken as six advances of
   * 0.25 s settles by 1.0 s, so what converges depends on how the advance is
   * chopped rather than on simulated time alone. Which is the argument for
   * settling on STATE (AGENTS.md) instead of picking another number — a bigger
   * constant would only move the day this comes back.
   */
  const settled = async (deadlineMs = 6000) => {
    const t0 = Date.now();
    let last = await dist();
    for (;;) {
      await page.evaluate(() => window.__dbgAdvance(0.25));
      const now = await dist();
      // A millimetre: far under the 0.05 the assertions below care about, and
      // far over the float noise of recomputing a hypotenuse.
      if (Math.abs(now - last) < 0.001) {
        return now;
      }
      last = now;
      if (Date.now() - t0 > deadlineMs) {
        check(false, `the camera never settled — still moving after ${deadlineMs} ms`);
        return now;
      }
    }
  };
  const scroll = async (x, y, dy) => {
    await page.mouse.move(x, y);
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel({ deltaY: dy });
    }
    return settled();
  };
  // THE CONTROL RUNS FIRST, and the order is load-bearing: Chrome latches a
  // wheel gesture to the scroller it started on, so four notches into the panel
  // followed immediately by four over the world are still delivered to the
  // panel — which reads exactly like the leak this section is looking for, from
  // the one arrangement that cannot see it.
  // Settled, not merely read: section 8 spawned and cleared structures right in
  // front of the lens, and the camera avoids what is in the way — so the
  // baseline this section compares against has to be a resting value too.
  const before = await settled();
  const r0 = await read();
  const overWorld = await scroll(1100, 450, 200);
  const r1 = await read();
  // THE OTHER HALF OF SECTION 8, and the one that needs no camera driving of its
  // own: zooming out moves the LENS and nothing else — the hero has not walked
  // and has not turned — so his own facing still names the same point while the
  // crosshair ray, now starting further back and higher, meets the ground
  // somewhere else. `ahead` unchanged with `spot` moved is the whole claim.
  const aimMoved = Math.hypot(r1.spot.x - r0.spot.x, r1.spot.z - r0.spot.z);
  const heroMoved = Math.hypot(r1.ahead.x - r0.ahead.x, r1.ahead.z - r0.ahead.z);
  results.aimFollowsLens = {
    spotBefore: r0.spot,
    spotAfter: r1.spot,
    moved: +aimMoved.toFixed(2),
    heroMoved: +heroMoved.toFixed(2),
  };
  check(
    heroMoved < 0.2,
    `the hero moved ${heroMoved.toFixed(2)} m during the zoom — the comparison is not clean`,
  );
  check(
    aimMoved > 1,
    `the crosshair spot moved ${aimMoved.toFixed(2)} m when the lens pulled back ` +
      "— it is not following the camera",
  );
  // ...then the panel, pulling the OTHER way. A leak would walk the camera back
  // in from wherever the control left it, so the assertion is "did not move"
  // against a gesture that would visibly move it.
  const overPanel = await scroll(box.x, box.y, -200);

  results.wheel = {
    before: +before.toFixed(3),
    overWorld: +overWorld.toFixed(3),
    overPanel: +overPanel.toFixed(3),
  };
  check(
    Math.abs(overWorld - before) > 0.3,
    `the control scroll moved the camera only ${(overWorld - before).toFixed(2)} m ` +
      "— this section proves nothing",
  );
  check(
    Math.abs(overPanel - overWorld) < 0.05,
    `scrolling the panel moved the camera ${(overPanel - overWorld).toFixed(2)} m`,
  );
}

console.log(JSON.stringify({ ...results, failures: fails, pass: fails.length === 0 }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
