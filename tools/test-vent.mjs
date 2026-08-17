// THE VENT UNDER CINDERHELM (issue #265): a gateway on a MOVING deck, crossed
// both ways with the Use key.
//
// Usage: bun tools/test-vent.mjs      (dev server must be up)
//
// `test-gateway` proves the arch rules on the ground; this is the half the
// hold never asked — the pad rides a carrier, so where it IS is a reading and
// not a place, and coming back up must put the hero on the deck he left, not
// on the ground under it.
//
// Four claims:
//
//   1. THE ARCH RIDES THE DECK. The overworld has a `vent` gate, flagged
//      carried, standing on Cinderhelm's turf — and its offset from the island
//      holds while the island moves.
//   2. THE PRESS GOES DOWN. Standing in the arch and pressing Use lands the
//      hero in `vent`, and the arrival counts as `descend-the-vent`.
//   3. AND COMES BACK UP ONTO THE DECK: the return pad is disarmed where he
//      lands, arms when he steps off, and the press puts him back on
//      Cinderhelm's deck — inside its radius, at deck height, nowhere near the
//      camp `spawnPoint` the hold's return uses.
//   4. THE SHELF IS NOT THE DESCENT: with the quest active, standing on
//      Cinderhelm marks nothing (#160 wanted a real dive, not an arrival).
//
// Exits non-zero on failure.
import { launchBrowser, newPage, wait } from "./browser.mjs";
import { BASE as HOST, NO_WARMUP } from "./target.mjs";

// No `fps=`: the crossing waits on the destination being built, which is real
// work at whatever rate it runs.
const URL = `${HOST}/?menu=0&fs=0&vol=0&${NO_WARMUP}`;
const Q4 = "quest:sky/cinderhelm";
/** How long a crossing may take before this reports it as a hang, ms. */
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
const zone = () => dbg(() => window.__dbgZone());
const ventGate = async () => (await zone()).gates.find((g) => g.to === "vent") ?? null;
const isle = () =>
  dbg(() => {
    const k = window.__dbgCarriers().all.find((c) => c.id === "carrier:town:cinderhelm");
    return k ? { x: k.x, y: k.y, z: k.z, r: k.radius } : null;
  });
const pos = () => dbg(() => window.__dbgPlayerPos());
const progress = () =>
  dbg(async (q) => {
    const { content } = await import("/src/content/index.ts");
    return content.state.progress(q, "descend-the-vent");
  }, Q4);
const streamed = async () => {
  for (let i = 0; i < 80 && (await dbg(() => window.__dbgZone().streaming)); i++) {
    await wait(250);
  }
};
/** Stand on a deck column: `y` given, so the teleport does not drop him to the ground under it. */
const tpDeck = async (x, z, y) => {
  await dbg((p) => window.__dbgTp(p.x, p.z, p.y + 0.3), { x, z, y });
  await streamed();
  await adv(0.5);
};

/** Press Use and wait for the zone to change, or give up. Wall clock: the far world is real work. */
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

// The quest is live so the arrival has something to count.
await dbg(async (q) => {
  const { content } = await import("/src/content/index.ts");
  content.state.setQuestStatus(q, "active");
}, Q4);
await adv(0.2);

// ---------- 1. the arch rides the deck ------------------------------------------
{
  const g0 = await ventGate();
  const c0 = await isle();
  check(g0 !== null, "the overworld has no gate to the vent");
  check(c0 !== null, "Cinderhelm is not a carrier in this world");
  if (g0 && c0) {
    check(g0.carried === true, "the vent's gate is not flagged as carried");
    const d0 = Math.hypot(g0.x - c0.x, g0.z - c0.z);
    check(d0 < c0.r, `the arch stands ${d0.toFixed(1)} from the island's middle, past its rim`);
    check(Math.abs(g0.y - c0.y) < 1, `the arch is at y=${g0.y}, the deck at ${c0.y}`);
    // The island roams; the arch must roam with it.
    await adv(20);
    const g1 = await ventGate();
    const c1 = await isle();
    const moved = Math.hypot(c1.x - c0.x, c1.z - c0.z);
    const d1 = Math.hypot(g1.x - c1.x, g1.z - c1.z);
    results.rides = { moved: +moved.toFixed(2), offset0: +d0.toFixed(2), offset1: +d1.toFixed(2) };
    check(moved > 1, `Cinderhelm moved ${moved.toFixed(2)} in twenty seconds — nothing to prove riding against`);
    check(Math.abs(d1 - d0) < 0.5, `the arch's offset from the island drifted ${d0.toFixed(2)} -> ${d1.toFixed(2)}`);
  }
}

// ---------- 4. the shelf is not the descent ---------------------------------------
{
  const c = await isle();
  await tpDeck(c.x + 20, c.z, c.y);
  await adv(2);
  const p = await progress();
  results.shelf = { descend: p };
  check(p === 0, `standing on Cinderhelm's deck counted as the descent (${p})`);
}

// ---------- 2. the press goes down ----------------------------------------------
{
  const g = await ventGate();
  await tpDeck(g.x, g.z, g.y);
  await wait(500);
  const before = await zone();
  check(before.gate.inside === true, "the hero is not standing in the vent's arch");
  const outMs = await pressAndCross("overworld");
  const z = await zone();
  const p = await progress();
  results.down = { ms: outMs, zone: z.id, descend: p };
  check(outMs !== null, `the crossing never fired in ${CROSS_TIMEOUT / 1000}s of pressing Use`);
  check(z.id === "vent", `the press left the hero in "${z.id}"`);
  check(p >= 1, "arriving in the vent did not count as descend-the-vent");
}

// ---------- 3. and back up onto the deck ------------------------------------------
{
  const landed = await zone();
  check(landed.gate.inside === true, "the hero did not land on the return pad");
  check(landed.gate.armed === false, "the return pad was armed the moment he landed on it");
  const g = landed.gate;
  await dbg((p) => window.__dbgTp(p.x + 12, p.z + 12), g);
  await wait(700);
  const armed = (await zone()).gate.armed;
  check(armed === true, "walking off the return pad did not arm it");
  // The overworld is rebuilt under gameplay (`keepReturn`); wait for it honestly.
  let resident = null;
  for (let i = 0; i < 60; i++) {
    resident = (await zone()).pending;
    if (resident?.ready === true) {
      break;
    }
    await wait(500);
  }
  check(resident?.ready === true, `the overworld is not resident-and-ready: ${JSON.stringify(resident)}`);
  await dbg((p) => window.__dbgTp(p.x, p.z), g);
  await wait(500);
  const backMs = await pressAndCross("vent");
  await streamed();
  await adv(0.5);
  const z = await zone();
  const c = await isle();
  const p = await pos();
  const spawn = await dbg(() => window.__dbgTowns().spawn);
  const fromIsle = c ? Math.hypot(p.x - c.x, p.z - c.z) : Infinity;
  const fromSpawn = Math.hypot(p.x - spawn.x, p.z - spawn.z);
  results.up = { ms: backMs, zone: z.id, fromIsle: +fromIsle.toFixed(2), fromSpawn: +fromSpawn.toFixed(2), y: p.y, deck: c?.y };
  check(backMs !== null, `the way out of the vent never fired in ${CROSS_TIMEOUT / 1000}s`);
  check(z.id === "overworld", `the return left the hero in "${z.id}"`);
  check(c !== null && fromIsle < c.r, `the return put the hero ${fromIsle.toFixed(1)} from Cinderhelm — off the shelf`);
  check(c !== null && p.y > c.y - 1 && p.y < c.y + 6, `the return put the hero at y=${p.y}, the deck is ${c?.y}`);
  check(fromSpawn > 100, "the return landed at the camp spawnPoint — the hold's contract, not the vent's");
}

console.log(JSON.stringify({ ...results, failures: fails, pass: fails.length === 0 }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
