// Verifies the melee aim assist: a sword swing is steered onto the enemy
// nearest the CROSSHAIR, and only when one is inside the swing's own reach.
//
// The question this asks that nothing else could: an arc that hits everything in
// a 100-degree wedge already hits most of what you point at, so "the assist
// works" is not visible in whether an attack connects. It is only visible in the
// band OUTSIDE the arc — an enemy plainly on screen, plainly within arm's reach,
// and plainly missed.
//
// HOW IT AVOIDS CHOREOGRAPHING WILD ENEMIES, which is where the first two
// versions of this tool died. Wild spawns chase, attack, get knocked back and
// wander, so a scripted "stand exactly 68 degrees off at exactly 1.7 units" had
// decayed to 37 degrees by the strike frame and the `aim=0` control "hit" —
// proving nothing. So section 1 asserts an INVARIANT over whatever geometry
// actually occurred, read back from the probe: with the camera swept around the
// hero, the assist must select an enemy exactly when one is in reach and inside
// the cone. `__dbgAimAssist` reports both the chosen target and the best
// in-reach candidate with the cone opened out, so a refusal is checkable and not
// merely an absence.
//
// The pad is SYNTHETIC, for the same reasons as tools/test-gamepad.mjs — and
// because RT is a button this can press without taking pointer lock, which a
// real mouse click would.
//
// Usage: bun tools/test-aim-assist.mjs        (dev server must be up)
import { launchBrowser, newPage, wait, logPageErrors } from './browser.mjs';
import { BASE as HOST } from './target.mjs';

const BASE = `${HOST}/?fps=30&menu=0&fs=0`;
const B_RT = 7;

/** Inside `SWORD_REACH` (2.2) with room for the enemy's own radius. */
const STAND_OFF = 1.5;
/**
 * Where to park the enemy for the outcome A/B, in degrees off the crosshair.
 *
 * The only band that proves anything: outside the arc's ~50 degrees, so an
 * un-assisted swing must miss, and inside the assist's 75, so an assisted one
 * must hit. A trial that drifts out of 55..74 by the strike frame is discarded
 * and re-run rather than reported — see `trial`.
 */
const OFF_AXIS_DEG = 66;
const VALID_TURN = [55, 74];

const probe = (page, name) => page.evaluate((n) => window[n]?.(), name);
const setButton = (page, i, down) => page.evaluate((i, down) => {
  window.__fakePad.buttons[i] = { pressed: down, touched: down, value: down ? 1 : 0 };
}, i, down);

async function installFakePad(page) {
  await page.evaluateOnNewDocument(() => {
    const state = {
      id: 'Xbox Wireless Controller', index: 0, connected: true, mapping: 'standard',
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    };
    window.__fakePad = state;
    navigator.getGamepads = () => [state];
    window.__connectPad = () => {
      const ev = new Event('gamepadconnected');
      Object.defineProperty(ev, 'gamepad', { value: state });
      window.dispatchEvent(ev);
    };
  });
}

async function boot(page, url) {
  await installFakePad(page);
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await wait(4000);
  await page.evaluate(() => window.__connectPad());
  await wait(200);
}

/** The live enemy nearest the hero, or null. */
async function nearestEnemy(page) {
  const b = await probe(page, '__dbgBodies');
  let best = null;
  let bd = Infinity;
  for (const e of b.enemies) {
    if (e.isDead) continue;
    const d = Math.hypot(e.x - b.player.x, e.z - b.player.z);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

/**
 * Stand the hero `dist` from the nearest enemy, with the enemy due +Z.
 *
 * `aimCamera` writes the yaw outright, so pointing the lens is instant — but a
 * TELEPORT makes the follow camera swing, measured at 12 degrees settling to 0
 * over about 750 ms. Hence the wait here and none after the aim: move first,
 * let the lens catch up, and only then decide where to look.
 */
async function stand(page, dist) {
  const enemy = await nearestEnemy(page);
  if (!enemy) return null;
  await page.evaluate(({ x, z, d }) => window.__dbgTp(x, z - d), {
    x: enemy.x, z: enemy.z, d: dist,
  });
  await wait(850);
  return enemy;
}

/** Point the lens along `deg` and let the frame after it land. */
async function look(page, deg) {
  await page.evaluate((d) => window.__dbgAim((d * Math.PI) / 180), deg);
  await wait(120);
}

const browser = await launchBrowser();
const results = {};

// ---------- 1. the rule, swept ----------------------------------------------
//
// Sweep the crosshair around the hero and check, at every sample, that the
// assist selected an enemy exactly when one was in reach and inside the cone.
// The angles are whatever the world actually produced; nothing here depends on
// an enemy holding a mark.
{
  const page = await newPage(browser, { width: 1280, height: 800 });
  logPageErrors(page);
  await boot(page, BASE);

  const samples = [];
  for (const deg of [0, 20, 40, 55, 70, 80, 95, 120, 150, 180, -40, -70, -95, -150]) {
    await stand(page, STAND_OFF);
    await look(page, deg);
    const a = await probe(page, '__dbgAimAssist');
    if (!a?.inReach) continue;          // nobody close enough; nothing to assert
    samples.push({
      aimedDeg: deg,
      angleFromCrosshair: a.inReach.angleFromCrosshair,
      distance: a.inReach.distance,
      selected: a.target !== null,
      shouldSelect: a.inReach.angleFromCrosshair <= a.coneDeg,
    });
  }

  const wrong = samples.filter((s) => s.selected !== s.shouldSelect);
  const picked = samples.filter((s) => s.selected).map((s) => s.angleFromCrosshair);
  const refused = samples.filter((s) => !s.selected).map((s) => s.angleFromCrosshair);
  results.rule = {
    coneDeg: (await probe(page, '__dbgAimAssist'))?.coneDeg,
    samples: samples.length,
    // The two numbers the cone lives between. They must straddle it, and the
    // gap between them is the resolution this sweep actually proved.
    widestSelected: picked.length ? Math.max(...picked) : null,
    narrowestRefused: refused.length ? Math.min(...refused) : null,
    disagreements: wrong,
    holds: samples.length > 0 && wrong.length === 0,
    table: samples,
  };

  // THE ISSUE'S OTHER CLAUSE. Aimed straight at somebody well outside the
  // sword's reach: nothing to assist, and an assist that fired here would be
  // steering a swing at something it cannot touch.
  const far = await nearestEnemy(page);
  await page.evaluate(({ x, z }) => window.__dbgTp(x, z - 7), far);
  await wait(850);
  await look(page, 0);
  const outOfReach = await probe(page, '__dbgAimAssist');
  results.outOfReach = {
    target: outOfReach.target,
    inReach: outOfReach.inReach,
    // Both null is the whole assertion: not merely "no target", but "no target
    // AND nothing was in range", which is why it had no target.
    refusedBecauseNothingInRange: outOfReach.target === null && outOfReach.inReach === null,
  };
  await page.close();
}

// ---------- 2. the A/B: does the swing actually land? -----------------------
//
// Identical setup either side of `aim=0`. A trial is only counted once the probe
// confirms, at the moment of the swing, that the target sat outside the arc and
// inside the cone — so a run whose enemy wandered is retried instead of reported
// as a result.
async function trial(page) {
  for (let attempt = 0; attempt < 6; attempt++) {
    await stand(page, STAND_OFF);
    // Aim off-axis, then a THROWAWAY swing so the hero's heading settles onto
    // the new bearing before the one being measured. `targetHeading` only
    // chases the camera while an attack is live, so without this he swings from
    // wherever he was last facing and the control run misses for the wrong
    // reason.
    const enemy = await nearestEnemy(page);
    const pos = (await probe(page, '__dbgBodies')).player;
    const bearing = Math.atan2(enemy.x - pos.x, enemy.z - pos.z) * (180 / Math.PI);
    await look(page, bearing - OFF_AXIS_DEG);
    await setButton(page, B_RT, true);
    await wait(400);
    await setButton(page, B_RT, false);
    await wait(800);

    const before = await nearestEnemy(page);
    const aim = await probe(page, '__dbgAimAssist');
    const seen = aim?.inReach;
    if (!seen || seen.turn < VALID_TURN[0] || seen.turn > VALID_TURN[1]) continue;

    await setButton(page, B_RT, true);
    await wait(120);
    await setButton(page, B_RT, false);
    await wait(700);
    const after = await nearestEnemy(page);
    return {
      attempts: attempt + 1,
      assistEnabled: aim.enabled,
      angleFromCrosshair: seen.angleFromCrosshair,
      swingWouldTurn: seen.turn,
      distance: seen.distance,
      insideCone: aim.target !== null,
      hpBefore: before?.hp ?? null,
      hpAfter: after?.hp ?? null,
      hit: before && after ? after.hp < before.hp : null,
    };
  }
  return { attempts: 6, error: 'no trial landed in the valid band' };
}

for (const [label, url] of [['assistOn', BASE], ['assistOff', `${BASE}&aim=0`]]) {
  const page = await newPage(browser, { width: 1280, height: 800 });
  logPageErrors(page);
  await boot(page, url);
  results[label] = await trial(page);
  await page.close();
}

// A swing dead-ahead has to land with the assist OFF. Without this the pair
// above could pass on a swing that never happened at all — a broken attack
// button looks exactly like a working `aim=0`.
{
  const page = await newPage(browser, { width: 1280, height: 800 });
  logPageErrors(page);
  await boot(page, `${BASE}&aim=0`);
  await stand(page, STAND_OFF);
  await look(page, 0);
  await setButton(page, B_RT, true);
  await wait(400);
  await setButton(page, B_RT, false);
  await wait(800);
  const before = await nearestEnemy(page);
  const aim = await probe(page, '__dbgAimAssist');
  await setButton(page, B_RT, true);
  await wait(120);
  await setButton(page, B_RT, false);
  await wait(700);
  const after = await nearestEnemy(page);
  results.assistOffAimedAtIt = {
    swingWouldTurn: aim?.inReach?.turn ?? null,
    hpBefore: before?.hp ?? null,
    hpAfter: after?.hp ?? null,
    hit: before && after ? after.hp < before.hp : null,
  };
  await page.close();
}

console.log(JSON.stringify(results, null, 2));
await browser.close();
