// CROSSING A GATEWAY, both ways, the way a player does — with the Use key.
//
// Usage: bun tools/test-gateway.mjs      (dev server must be up)
//
// WHY THIS EXISTS: the crossing had no probe at all. `test-proximity` asserts
// the pad's shape (a cylinder, not a column) and stops short of committing on
// purpose, and every other probe that needed a second zone reached for `/zone`,
// which skips the arch entirely. So the one thing a player cannot recover from
// — walking into a dungeon and not being able to walk out — was the one thing
// nothing drove. It was reported from a real session (a return that never fired
// under a hint reading "Entering Embervale… 278%").
//
// Five claims:
//
//   1. STANDING IN THE ARCH IS NOT ENTERING IT. The hero stands on the pad for
//      several seconds and the zone does not change: the crossing is a PRESS,
//      and a player walking through an arch on his way somewhere else keeps
//      walking.
//   2. THE PROMPT OFFERS THE KEY. Not a percentage — the old hint was a share
//      of a dwell that the crossing did not actually wait on, so it ran past
//      100% while the far side was still building.
//   3. THE PRESS CROSSES. Out of the overworld, into the hold.
//   4. AND THE WAY BACK WORKS, which is the reported bug. The return pad is
//      DISARMED on arrival — you are standing on it — so this walks off it,
//      walks back, and presses. Both halves: the press is refused while he is
//      still standing where he landed, and taken after he has stepped out.
//   5. THE RETURN LANDS ON `spawnPoint`, which is the contract Act 2 and Act 3
//      copy from `hold` (game-story.md §4).
//
// Exits non-zero on failure.
import { launchBrowser, newPage, wait } from "./browser.mjs";
import { BASE as HOST } from "./target.mjs";

// No `fps=`: nothing here is a frame-edge assertion, and the crossing waits on
// the destination being built, which is real work at whatever rate it runs.
const URL = `${HOST}/?menu=0&vol=0`;

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
await page.waitForFunction(() => window.__dbgBoot && window.__dbgBoot().playing, {
  timeout: 60000,
});
await wait(400);

const dbg = (fn, ...args) => page.evaluate(fn, ...args);
const zone = () => dbg(() => window.__dbgZone());
const hint = () => dbg(() => document.querySelector(".bs-hint")?.textContent ?? null);
const tp = (x, z) => dbg((p) => window.__dbgTp(p.x, p.z), { x, z });

/** Stand on the pad and let the world settle around him. */
async function standOnPad() {
  const g = (await zone()).gate;
  await tp(g.x, g.z);
  await wait(500);
  return g;
}

/**
 * Press Use and wait for the zone to change, or give up.
 *
 * WALL CLOCK, not simulated: the crossing waits on the far world streaming and
 * on the warm-up sweep, and both are real work that `__dbgAdvance` cannot skip.
 * The returned time is reported so a crossing that gets slower is visible even
 * when it still passes.
 */
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

// ---------- 1 & 2. standing is not entering, and the prompt names the key ----
{
  const g = await standOnPad();
  const before = await zone();
  await wait(4000);
  const after = await zone();
  const prompt = await hint();
  results.standing = {
    gate: { to: g.to, x: g.x, z: g.z },
    inside: after.gate.inside,
    armed: after.gate.armed,
    requested: after.gate.requested,
    transitionsBefore: before.transitions,
    transitionsAfter: after.transitions,
    zone: after.id,
    hint: prompt,
  };
  check(
    after.gate.inside === true,
    "the hero is not standing in the arch — nothing below is proven",
  );
  check(
    after.id === before.id && after.transitions === before.transitions,
    `four seconds in the arch crossed a hero who pressed nothing (${before.id} -> ${after.id})`,
  );
  check(after.gate.requested === false, "the gateway asked to cross on its own");
  check(prompt !== null, "no prompt for a hero standing in the gateway");
  // The number is what the report was about: a share of a wait the crossing did
  // not actually depend on. There is no number now.
  check(
    prompt !== null && !/\d+\s*%/.test(prompt),
    `the prompt still offers a percentage: "${prompt}"`,
  );
}

// ---------- 3. the press crosses --------------------------------------------
{
  const outMs = await pressAndCross("overworld");
  const z = await zone();
  results.out = { ms: outMs, zone: z.id, transitions: z.transitions };
  check(outMs !== null, `the crossing never fired in ${CROSS_TIMEOUT / 1000}s of pressing Use`);
  check(z.id === "hold", `the press left the hero in "${z.id}"`);
}

// ---------- 4. and the way back, which is the reported bug -------------------
{
  // Where he landed: ON the return pad, and it must be disarmed there.
  const landed = await zone();
  const refused = await dbg(() => window.__dbgZone().gate.requested);
  await page.keyboard.press("KeyE");
  await wait(600);
  const afterPress = await zone();
  results.landed = {
    inside: landed.gate.inside,
    armed: landed.gate.armed,
    requestedBefore: refused,
    requestedAfter: afterPress.gate.requested,
    zone: afterPress.id,
  };
  check(landed.gate.inside === true, "the hero did not land on the return pad");
  check(landed.gate.armed === false, "the return pad was armed the moment he landed on it");
  check(
    afterPress.gate.requested === false && afterPress.id === "hold",
    "a press on the pad he just landed on sent him straight back",
  );

  // Step out to arm it, step back, and press.
  const g = landed.gate;
  await tp(g.x + 12, g.z + 12);
  await wait(700);
  const armed = (await zone()).gate.armed;
  await tp(g.x, g.z);
  await wait(500);
  const backMs = await pressAndCross("hold");
  const z = await zone();
  results.back = { armedAfterStepOut: armed, ms: backMs, zone: z.id };
  check(armed === true, "walking off the return pad did not arm it");
  check(backMs !== null, `the way out of the hold never fired in ${CROSS_TIMEOUT / 1000}s`);
  check(z.id === "overworld", `the return left the hero in "${z.id}"`);
}

// ---------- 5. and it lands on spawnPoint ------------------------------------
{
  const where = await dbg(() => {
    const p = window.__dbgPlayerPos();
    const s = window.__dbgTowns().spawn;
    return { p, s, d: Math.hypot(p.x - s.x, p.z - s.z) };
  });
  results.landing = { ...where, d: +where.d.toFixed(2) };
  // A few units: the hero is placed AT spawnPoint and then falls to the ground
  // under it, and a beast following him can nudge him off the mark.
  check(
    where.d < 6,
    `the return put the hero ${where.d.toFixed(1)} units from spawnPoint — the contract Act 2 copies`,
  );
}

console.log(JSON.stringify({ ...results, failures: fails, pass: fails.length === 0 }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
