// Verifies issue #78: nothing in the game reacts to a player who is only close
// in the horizontal. Every "is he near it" test is a CYLINDER — a radius plus a
// height band — and this asserts the height half of four of them, in the game,
// from the air.
//
// WHY IT IS ONE TOOL AND NOT FOUR SECTIONS SPREAD OVER FOUR. The defect was not
// four bugs; it was one missing rule (`inReach`/`inRise`, src/core/types.ts)
// that four features each had their own flat copy of. A guard split across
// test-npc, test-inventory and test-aim-assist would let the next feature ship
// its own flat copy and stay green, because nothing would be asserting the RULE.
//
// EVERY SECTION IS A PAIR, and the ground half is not a formality: "the portal
// did not fire while I was in the sky" is equally true of a working height gate
// and of a probe that never got near the arch, or a hero who never spawned.
// Ground first where the order allows it, so a broken positive fails loudly
// rather than silently excusing the negative.
//
// HOW THE HERO STAYS UP. `__dbgTp` writes a position and zeroes velocity;
// gravity then reclaims him at 24 u/s². Two techniques, both here:
//   - for a QUERY, teleport and read inside ONE page.evaluate, so not a single
//     frame passes between them and the reading is exact;
//   - for anything that has to LAST (a 1.2 s portal dwell, a 0.9 s swing), an
//     in-page interval re-teleports him every 16 ms. See `hover`.
//
// Usage: bun tools/test-proximity.mjs        (dev server must be up)
//
// Exits non-zero on failure.
import { launchBrowser, newPage, wait, logPageErrors } from './browser.mjs';
import { BASE as HOST } from './target.mjs';

// Companions are disabled because this section measures the HERO'S sword. A
// companion hit between the two hp reads is indistinguishable from an airborne
// sword hit and made the negative control depend on AI timing under load.
const URL = `${HOST}/?menu=0&fs=0&fps=30&beasts=0`;
const B_RT = 7;
/** How far up "in the sky" is. Well past every band in the game, and clear of
 *  the arch itself (5 units tall), so nothing here is a near-miss. */
const SKY = 12;

const probe = (page, name) => page.evaluate((n) => window[n]?.(), name);

/** The hint pill exactly as a player sees it: text, or null when it is hidden. */
const hint = (page) => page.evaluate(() => {
  const el = document.querySelector('.bs-hint');
  if (!el || !el.classList.contains('show')) return null;
  const s = (el.textContent || '').trim();
  return s.length ? s : null;
});

/** Teleport and read a hook in the SAME tick — no frame, so no falling. */
const readAt = (page, x, y, z, name) => page.evaluate((a, b, c, n) => {
  window.__dbgTp(a, c, b);
  return window[n]?.();
}, x, y, z, name);

/**
 * Pin the hero at a point for `ms`, then let go. The interval runs in the page
 * so it re-applies between frames rather than between round-trips.
 */
async function hover(page, x, y, z, ms) {
  await page.evaluate((a, b, c) => {
    window.__dbgTp(a, c, b);
    window.__holdTimer = setInterval(() => window.__dbgTp(a, c, b), 16);
  }, x, y, z);
  await wait(ms);
}
const release = (page) => page.evaluate(() => {
  clearInterval(window.__holdTimer);
  window.__holdTimer = null;
});

const results = {};
const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); };

const browser = await launchBrowser();
const page = await newPage(browser, { width: 1280, height: 800 });
logPageErrors(page);
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
await page.goto(URL, { waitUntil: 'load' });
await page.waitForSelector('canvas');
await wait(4500);
await page.evaluate(() => window.__connectPad());
await wait(200);
const setButton = (i, down) => page.evaluate((a, b) => {
  window.__fakePad.buttons[a] = { pressed: b, touched: b, value: b ? 1 : 0 };
}, i, down);

const zone0 = await probe(page, '__dbgZone');
if (!zone0?.gate) {
  console.error('__dbgZone().gate is not there — nothing below can run');
  await browser.close();
  process.exit(1);
}
const gate = zone0.gate;

// ---------- 1. the zone gateway, from the air ------------------------------
//
// The case in the report. Hold the hero SKY units over the arch for twice the
// dwell it needs: the pad must never arm a countdown, the prompt must never
// appear, and the zone must not change under him.
{
  await hover(page, gate.x, gate.y + SKY, gate.z, 2800);
  const above = await probe(page, '__dbgZone');
  const aboveHint = await hint(page);
  await release(page);

  results.gatewayFromAir = {
    gate: { x: gate.x, y: gate.y, z: gate.z },
    dist: above.gate.dist, rise: above.gate.rise,
    inside: above.gate.inside, dwell: above.gate.dwell,
    transitions: above.transitions, hint: aboveHint, zone: above.id,
  };
  // The horizontal half has to be SATISFIED or the height gate is untested:
  // this is the whole point of hovering over the arch rather than beside it.
  check(above.gate.dist < zone0.radii.enter,
    `hero was ${above.gate.dist} out horizontally — not over the pad, so nothing here is proven`);
  check(above.gate.inside === false,
    `the pad accepted a hero ${above.gate.rise} units above it`);
  check(above.gate.dwell === 0,
    `the gateway counted ${above.gate.dwell}s of dwell from the sky`);
  check(above.transitions === zone0.transitions,
    'the hero was pulled through a portal he flew over');
  check(aboveHint === null,
    `a prompt was offered to a hero ${above.gate.rise} units up: "${aboveHint}"`);
}

// ---------- 2. ...and on foot, where it must still work --------------------
//
// The other half. Same arch, same hero, feet on the pad: the prompt appears and
// the dwell runs. Left as a DWELL rather than a completed transition on purpose
// — committing would swap the world out from under sections 3 and 4.
{
  await hover(page, gate.x, gate.y, gate.z, 900);
  const on = await probe(page, '__dbgZone');
  const onHint = await hint(page);
  await release(page);
  // Off the pad before it commits, and far enough to re-arm cleanly.
  await page.evaluate((x, z) => window.__dbgTp(x + 40, z + 40), gate.x, gate.z);
  await wait(600);

  results.gatewayOnFoot = {
    dist: on.gate.dist, rise: on.gate.rise, inside: on.gate.inside,
    dwell: on.gate.dwell, hint: onHint,
  };
  check(on.gate.inside === true, 'the pad refused a hero standing on it');
  check(on.gate.dwell > 0, 'standing in the arch counted no dwell at all');
  check(onHint !== null, 'no prompt for a hero standing in the gateway');
}

// ---------- 3. the skill den ------------------------------------------------
{
  const shops = await probe(page, '__dbgShops');
  const den = shops?.[0] ?? null;
  if (!den) {
    check(false, 'no skill den in this world — the den half cannot be tested');
  } else {
    await page.evaluate((x, z) => window.__dbgTp(x, z), den.x, den.z);
    await wait(700);
    const ground = await hint(page);
    await hover(page, den.x, den.y + SKY, den.z, 700);
    const air = await hint(page);
    await release(page);
    results.skillDen = { den, ground, air };
    check(ground !== null, 'no prompt for a hero standing at a skill den');
    check(air === null, `the den offered its prompt ${SKY} units overhead: "${air}"`);
  }
}

// ---------- 4. the sword ----------------------------------------------------
//
// The QUERY first — `__dbgAimAssist().inReach` is the assist with its cone
// opened to 180 degrees, i.e. "who is close enough to be swung at, whatever the
// crosshair is doing" — and then the OUTCOME, which is the only statement about
// combat that is about the game rather than about the maths.
{
  const bodies = await probe(page, '__dbgBodies');
  const live = bodies.enemies.filter((e) => !e.isDead);
  const near = live.length
    ? live.reduce((a, b) => (
      Math.hypot(a.x - bodies.player.x, a.z - bodies.player.z)
        < Math.hypot(b.x - bodies.player.x, b.z - bodies.player.z) ? a : b))
    : null;
  if (!near) {
    check(false, 'no live enemy anywhere — the sword half cannot be tested');
  } else {
    // Beside it, then straight up from the same spot. One evaluate each, so the
    // hero has not fallen a millimetre by the time the query runs.
    const beside = await readAt(page, near.x + 1.2, near.y, near.z, '__dbgAimAssist');
    const over = await readAt(page, near.x + 1.2, near.y + SKY, near.z, '__dbgAimAssist');
    results.swordQuery = {
      up: beside.up, down: beside.down,
      beside: beside.inReach, above: over.inReach,
    };
    check(beside.inReach !== null,
      'nothing was in sword reach from 1.2 units away — the control failed, so the refusal below means nothing');
    check(over.inReach === null,
      `the swing would still have been steered at an enemy ${SKY} units below `
      + `(rise ${over.inReach?.rise})`);

    // ---- and the swing itself, held aloft while it plays out --------------
    const hpOf = async () => {
      const b = await probe(page, '__dbgBodies');
      const e = b.enemies.find((q) => q.id === near.id && !q.isDead);
      return e?.hp ?? null;
    };
    // From the sky: pinned above it for the whole animation.
    await hover(page, near.x + 1.2, near.y + SKY, near.z, 500);
    const hpBeforeAir = await hpOf();
    await setButton(B_RT, true);
    await wait(150);
    await setButton(B_RT, false);
    await wait(900);
    const hpAfterAir = await hpOf();
    await release(page);

    // From the ground, beside it, facing it: the control. Reacquire immediately
    // before the swing. The wild enemy has been steering for the entire airborne
    // animation above; aiming at its several-seconds-old `near` coordinate made
    // this control depend on render timing and miss when issue #96 added two far
    // landscape draws, even though the reach query and combat code were unchanged.
    const reacquire = async (from) => {
      const b = await probe(page, '__dbgBodies');
      return b.enemies.find((e) => e.id === from.id && !e.isDead);
    };
    let groundTarget = await reacquire(near);
    await page.evaluate((x, z) => window.__dbgTp(x, z), groundTarget.x + 0.6, groundTarget.z);
    await wait(400);
    await page.evaluate((b) => window.__dbgAim(b), Math.atan2(-1.2, 0));
    await wait(400);
    // Track it once more after the smooth camera turn, then give the frame loop
    // one slice to apply the teleport. At 0.6 m the control remains well inside
    // the same melee reach asserted at 1.2 m above.
    groundTarget = await reacquire(groundTarget);
    await page.evaluate((x, z) => window.__dbgTp(x, z), groundTarget.x + 0.6, groundTarget.z);
    await wait(100);
    const hpBeforeGround = await hpOf();
    await setButton(B_RT, true);
    await wait(150);
    await setButton(B_RT, false);
    await wait(900);
    const hpAfterGround = await hpOf();

    results.swordOutcome = {
      air: { before: hpBeforeAir, after: hpAfterAir },
      ground: { before: hpBeforeGround, after: hpAfterGround },
    };
    check(hpBeforeAir !== null && hpAfterAir !== null && hpAfterAir >= hpBeforeAir,
      `a swing from ${SKY} units up took an enemy on the ground from ${hpBeforeAir} to ${hpAfterAir}`);
    // The control. Wild enemies move, so a miss here is not necessarily a bug in
    // the game — but it does mean the pair above proved nothing, and a silent
    // pass is exactly what this file exists to prevent.
    check(hpBeforeGround !== null && hpAfterGround !== null && hpAfterGround < hpBeforeGround,
      `the ground swing missed too (${hpBeforeGround} -> ${hpAfterGround}) — `
      + 'the airborne refusal above is unproven, not passing');
  }
}

console.log(JSON.stringify({ ...results, fails }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
