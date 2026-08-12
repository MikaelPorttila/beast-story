// Verifies that a hunting WILD BEAST fights in a rhythm instead of welding
// itself to the hero — issue #111.
//
// Usage: bun tools/test-beastaggro.mjs        (dev server must be up)
//
// WHAT THIS EXISTS FOR. The old chase copied the hero's position into the goal
// every slice and ran at it, so the beast arrived at arm's length and stayed
// there for the rest of the fight. That is invisible to every other guard:
// test-taming asks whether a bond forms, test-proximity asks whether a bite
// lands, and both are perfectly happy with an animal glued to your back. The
// only thing that tells the two builds apart is the SHAPE OF THE PATH the beast
// walks while it is hunting, which is what this measures.
//
// THE MEASUREMENT is one stationary hero and one wild beast, sampled ten times
// a second in SIMULATED time. Every reading is relative to the hero, so this
// says nothing about where in the world the fight happens:
//
//   near / far  — the closest and furthest it got while engaged;
//   sweep       — the total bearing it swept AROUND him, in radians, summed as
//                 shortest arcs so a lap is 2*pi and a jitter is nothing.
//
// EVERY ASSERTION IS PAIRED, because each half alone passes a broken build:
//
//   * it closes to biting range AND it does not stay there — "near" alone
//     passes the welded build this issue is about, and "far" alone passes a
//     beast that noticed the hero and ran away;
//   * it stays inside the leash AND it sweeps around him — "sweep" alone is
//     satisfied by an animal orbiting at forty units, which is not a fight.
//
// SIMULATED TIME, NOT WALL CLOCK. `__dbgAdvance` runs the sim slices directly,
// so the whole fight is bounded in work rather than in seconds and reads the
// same from a software rasteriser to a 165 Hz host.
//
// menu=0: this measures the world, so it needs the frame loop running.
//
// Exits non-zero on failure.
import { launchBrowser, newPage } from "./browser.mjs";
import { BASE as HOST } from "./target.mjs";

/** The species under test. Ground, bondable, and in the starting roster. */
const SPECIES = "wild-sproutle";
/** Sample interval and run length, in SIMULATED seconds. */
const STEP = 0.1;
const RUN = 14;
/**
 * A sample is only part of the fight once the beast has actually engaged.
 * The first slices are the walk in from wherever it was placed, and a straight
 * line covers no bearing — averaging it in would only dilute the reading.
 */
const ENGAGED_AT = 6;

const browser = await launchBrowser();
const page = await newPage(browser, { width: 1280, height: 800 });
page.on("pageerror", (e) => console.error("[page]", e.message));

await page.goto(`${HOST}/?menu=0&vol=0&fs=0`, { waitUntil: "load" });
await page.waitForSelector("canvas");
await page.waitForFunction(() => window.__dbgBoot?.().playing && window.__dbgAdvance, {
  timeout: 60000,
});

const results = {};
const fails = [];
const check = (ok, msg) => {
  if (!ok) {
    fails.push(msg);
  }
};

const adv = (s) => page.evaluate((n) => window.__dbgAdvance(n), s);
const tp = (x, z) => page.evaluate(([a, b]) => window.__dbgTp(a, b), [x, z]);
const zone = () => page.evaluate(() => window.__dbgZone());
const enemies = () => page.evaluate(() => window.__dbgBodies().enemies);

// -- an empty field, well outside the camp ----------------------------------
// The camp's huts would stop a circling beast dead — `moveGround` refuses a
// step into a structure — so the fight is staged on open ground. The offset is
// walked around a ring until one lands on land: which bearing is dry is a seed
// question, and the probe must not have an opinion about the seed.
const home = await page.evaluate(() => window.__dbgTowns().spawn);
let field = null;
for (let i = 0; i < 12 && !field; i++) {
  const a = i * 1.31;
  const x = home.x + Math.cos(a) * 120;
  const z = home.z + Math.sin(a) * 120;
  await tp(x, z);
  await page
    .waitForFunction(() => window.__dbgZone().streaming === false, { timeout: 30000 })
    .catch(() => {});
  await adv(0.5);
  const p = (await zone()).player;
  const wet = await page.evaluate(([a2, b]) => window.__dbgWorld(a2, b).water, [x, z]);
  // Dry, and the hero is where he was sent — a teleport that landed him
  // somewhere else means the column refused him, and so would the beast.
  if (!wet && Math.hypot(p.x - x, p.z - z) < 6) {
    field = { x: p.x, z: p.z };
  }
}
check(field !== null, "could not find open ground to stage the fight on");
if (!field) {
  console.log(JSON.stringify({ ...results, failures: fails, pass: false }, null, 2));
  await browser.close();
  process.exit(1);
}

// -- one beast, placed and then closed with ---------------------------------
const before = new Set((await enemies()).map((e) => e.id));
await page.evaluate((s) => window.__dbgSpawn("enemies", s), SPECIES);
await adv(0.2);
const fresh = (await enemies()).filter((e) => !before.has(e.id) && e.species === SPECIES);
check(fresh.length > 0, `__dbgSpawn placed no ${SPECIES}`);
if (!fresh.length) {
  console.log(JSON.stringify({ ...results, failures: fails, pass: false }, null, 2));
  await browser.close();
  process.exit(1);
}
const id = fresh[0].id;
// The spawner drops it under the crosshair, roughly fifteen units out — past
// the 8-unit aggro radius, so it would never notice him. Stand four units off
// instead, which is inside the radius and outside the bite.
await tp(fresh[0].x + 4, fresh[0].z);
await adv(0.3);

// -- watch the fight --------------------------------------------------------
const samples = [];
let sweep = 0;
let lastBearing = null;
for (let t = 0; t < RUN; t += STEP) {
  await adv(STEP);
  const p = (await zone()).player;
  const e = (await enemies()).find((x) => x.id === id);
  if (!e || e.isDead) {
    break;
  }
  const dx = e.x - p.x;
  const dz = e.z - p.z;
  const bearing = Math.atan2(dx, dz);
  if (lastBearing !== null && t >= ENGAGED_AT) {
    // SHORTEST ARC. atan2 wraps at pi, and an unwrapped subtraction there would
    // count a two-degree step as a full turn.
    let d = bearing - lastBearing;
    while (d > Math.PI) {
      d -= Math.PI * 2;
    }
    while (d < -Math.PI) {
      d += Math.PI * 2;
    }
    sweep += Math.abs(d);
  }
  lastBearing = bearing;
  samples.push({ t: +t.toFixed(1), d: Math.hypot(dx, dz), hp: p.hp });
}

const engaged = samples.filter((s) => s.t >= ENGAGED_AT);
check(engaged.length > 40, `only ${engaged.length} engaged samples — the fight never got going`);

const near = Math.min(...engaged.map((s) => s.d));
const far = Math.max(...engaged.map((s) => s.d));
// Bites, read off the hero's health rather than off a combat hook: an 8-point
// drop between two samples a tenth of a second apart is a bite, and passive
// regen is far too slow to be mistaken for one in either direction.
let bites = 0;
for (let i = 1; i < samples.length; i++) {
  if (samples[i - 1].hp - samples[i].hp > 3) bites++;
}

results.fight = {
  species: SPECIES,
  samples: samples.length,
  near: +near.toFixed(2),
  far: +far.toFixed(2),
  spread: +(far - near).toFixed(2),
  sweepRad: +sweep.toFixed(2),
  bites,
  hpLeft: samples.length ? samples[samples.length - 1].hp : null,
};

// IT ENGAGES. `stopAt` is radius (0.42) + 0.9, and the bite reaches radius + 1;
// 2.2 is that with room for a slice of overshoot. A beast that never gets this
// close is not fighting at all, and every reading below would be meaningless.
check(near <= 2.2, `the beast never got closer than ${near.toFixed(2)} m — it is not engaging`);
// IT BREAKS OFF. The other half, and the issue itself. WILD_RING_OUT is 3.6, so
// a full press-to-circle swing moves it several metres; 2.0 is comfortably
// above anything the old build could produce, where the goal WAS the hero and
// the spread was the hero's own jitter.
check(
  far - near >= 2.0,
  `the beast held station between ${near.toFixed(2)} and ${far.toFixed(2)} m ` +
    "— it is still welded to the hero",
);
// IT STAYS IN THE FIGHT. The pair for the two above: breaking off is not
// fleeing. The leash is aggro * 2.2 = 17.6; anything past 10 is a beast that
// lost interest, not one that circled.
check(far <= 10, `the beast ran ${far.toFixed(2)} m away — that is a retreat, not a break-off`);
// IT CIRCLES. Two radians is under a third of a lap over eight engaged seconds
// — a low bar on purpose, because the swing direction flips at random and two
// flips can cancel. The old build's sweep against a stationary hero is ~0.
check(
  sweep >= 2.0,
  `the beast swept only ${sweep.toFixed(2)} rad around the hero — it is not circling`,
);

console.log(JSON.stringify({ ...results, failures: fails, pass: fails.length === 0 }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
