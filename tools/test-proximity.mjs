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
//   - for anything that has to LAST (a held prompt, a 0.9 s swing), an
//     in-page interval re-teleports him every 16 ms. See `hover`.
//
// Usage: bun tools/test-proximity.mjs        (dev server must be up)
//
// Exits non-zero on failure.
import { launchBrowser, newPage, wait, logPageErrors } from "./browser.mjs";
import { BASE as HOST } from "./target.mjs";

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
const hint = (page) =>
  page.evaluate(() => {
    const el = document.querySelector(".bs-hint");
    if (!el || !el.classList.contains("show")) {
      return null;
    }
    const s = (el.textContent || "").trim();
    return s.length ? s : null;
  });

/** Teleport and read a hook in the SAME tick — no frame, so no falling. */
const readAt = (page, x, y, z, name) =>
  page.evaluate(
    (a, b, c, n) => {
      window.__dbgTp(a, c, b);
      return window[n]?.();
    },
    x,
    y,
    z,
    name,
  );

/**
 * Pin the hero at a point for `ms`, then let go. The interval runs in the page
 * so it re-applies between frames rather than between round-trips.
 */
async function hover(page, x, y, z, ms) {
  await page.evaluate(
    (a, b, c) => {
      window.__dbgTp(a, c, b);
      window.__holdMinY = b;
      window.__holdTimer = setInterval(() => {
        // Read BEFORE re-pinning: whatever the hero sagged to between ticks is
        // the height the swing actually happened at. A wall-clock interval
        // slips under load — gravity is 24 u/s², so a one-second stall IS the
        // whole 12-unit hold — and without this number a failure cannot say
        // whether the hold slipped or the refusal band broke (issue #186).
        const p = window.__dbgPlayerPos();
        if (p.y < window.__holdMinY) {
          window.__holdMinY = p.y;
        }
        window.__dbgTp(a, c, b);
      }, 16);
    },
    x,
    y,
    z,
  );
  await wait(ms);
}
const release = (page) =>
  page.evaluate(() => {
    clearInterval(window.__holdTimer);
    window.__holdTimer = null;
  });

const results = {};
const fails = [];
const check = (ok, msg) => {
  if (!ok) {
    fails.push(msg);
  }
};

const browser = await launchBrowser();
const page = await newPage(browser, { width: 1280, height: 800 });
logPageErrors(page);
await page.evaluateOnNewDocument(() => {
  const state = {
    id: "Xbox Wireless Controller",
    index: 0,
    connected: true,
    mapping: "standard",
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
  };
  window.__fakePad = state;
  navigator.getGamepads = () => [state];
  window.__connectPad = () => {
    const ev = new Event("gamepadconnected");
    Object.defineProperty(ev, "gamepad", { value: state });
    window.dispatchEvent(ev);
  };
});
await page.goto(URL, { waitUntil: "load" });
await page.waitForSelector("canvas");
await wait(4500);
await page.evaluate(() => window.__connectPad());
await wait(200);
const setButton = (i, down) =>
  page.evaluate(
    (a, b) => {
      window.__fakePad.buttons[a] = { pressed: b, touched: b, value: b ? 1 : 0 };
    },
    i,
    down,
  );

const zone0 = await probe(page, "__dbgZone");
if (!zone0?.gate) {
  console.error("__dbgZone().gate is not there — nothing below can run");
  await browser.close();
  process.exit(1);
}
const gate = zone0.gate;

// ---------- 1. the zone gateway, from the air ------------------------------
//
// The case in the report. Hold the hero SKY units over the arch: the pad must
// never claim him, the prompt must never appear, and a press must not be taken
// — a gateway takes a Use press now, so "would it accept one" is the question
// the height gate really answers.
{
  await hover(page, gate.x, gate.y + SKY, gate.z, 2800);
  const above = await probe(page, "__dbgZone");
  const aboveHint = await hint(page);
  await release(page);

  results.gatewayFromAir = {
    gate: { x: gate.x, y: gate.y, z: gate.z },
    dist: above.gate.dist,
    rise: above.gate.rise,
    inside: above.gate.inside,
    requested: above.gate.requested,
    transitions: above.transitions,
    hint: aboveHint,
    zone: above.id,
  };
  // The horizontal half has to be SATISFIED or the height gate is untested:
  // this is the whole point of hovering over the arch rather than beside it.
  check(
    above.gate.dist < zone0.radii.enter,
    `hero was ${above.gate.dist} out horizontally — not over the pad, so nothing here is proven`,
  );
  check(above.gate.inside === false, `the pad accepted a hero ${above.gate.rise} units above it`);
  check(above.gate.requested === false, "the gateway was asked to cross by a hero flying over it");
  check(
    above.transitions === zone0.transitions,
    "the hero was pulled through a portal he flew over",
  );
  check(
    aboveHint === null,
    `a prompt was offered to a hero ${above.gate.rise} units up: "${aboveHint}"`,
  );
}

// ---------- 2. ...and on foot, where it must still work --------------------
//
// The other half. Same arch, same hero, feet on the pad: the pad claims him and
// the prompt offers the crossing. NOT PRESSED, on purpose — committing would
// swap the world out from under sections 3 and 4, and what is under test here is
// proximity, not the crossing.
{
  await hover(page, gate.x, gate.y, gate.z, 900);
  const on = await probe(page, "__dbgZone");
  const onHint = await hint(page);
  await release(page);
  // Off the pad before it commits, and far enough to re-arm cleanly.
  await page.evaluate((x, z) => window.__dbgTp(x + 40, z + 40), gate.x, gate.z);
  await wait(600);

  results.gatewayOnFoot = {
    dist: on.gate.dist,
    rise: on.gate.rise,
    inside: on.gate.inside,
    armed: on.gate.armed,
    hint: onHint,
  };
  check(on.gate.inside === true, "the pad refused a hero standing on it");
  // AND IT WOULD TAKE THE PRESS: armed is the other half of "this arch is live",
  // and without it the prompt below would be an offer nothing honours.
  check(on.gate.armed === true, "the pad claimed the hero but was not armed to take a press");
  check(onHint !== null, "no prompt for a hero standing in the gateway");
}

// ---------- 3. the skill den ------------------------------------------------
{
  const shops = await probe(page, "__dbgShops");
  const den = shops?.[0] ?? null;
  if (!den) {
    check(false, "no skill den in this world — the den half cannot be tested");
  } else {
    await page.evaluate((x, z) => window.__dbgTp(x, z), den.x, den.z);
    await wait(700);
    const ground = await hint(page);
    await hover(page, den.x, den.y + SKY, den.z, 700);
    const air = await hint(page);
    await release(page);
    results.skillDen = { den, ground, air };
    check(ground !== null, "no prompt for a hero standing at a skill den");
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
  const bodies = await probe(page, "__dbgBodies");
  // A TARGET ON THE GROUND, and that filter is the whole point of the control.
  //
  // The claim is that a sword refuses a target directly OVERHEAD and lands on
  // one BESIDE the hero. A FLYER is neither: it hovers a few units up under its
  // own steering, so the "beside it" control swings at something that is already
  // out of vertical reach and misses — failing the pair while saying nothing at
  // all about the reach rule.
  //
  // The hole was always here: Peckit is a flyer and the nearest enemy was
  // sometimes one. Issue #4 added a second flyer to the roster and the coin came
  // up tails often enough to see it. Height above the HERO is what says
  // airborne, which is cheaper than teaching this probe what a species is and is
  // the same quantity the reach rule itself is written in.
  const live = bodies.enemies.filter((e) => !e.isDead && e.y - bodies.player.y < 1.6);
  const near = live.length
    ? live.reduce((a, b) =>
        Math.hypot(a.x - bodies.player.x, a.z - bodies.player.z) <
        Math.hypot(b.x - bodies.player.x, b.z - bodies.player.z)
          ? a
          : b,
      )
    : null;
  if (!near) {
    check(false, "no live GROUND enemy anywhere — the sword half cannot be tested");
  } else {
    // Beside it, then straight up from the same spot. One evaluate each, so the
    // hero has not fallen a millimetre by the time the query runs.
    const beside = await readAt(page, near.x + 1.2, near.y, near.z, "__dbgAimAssist");
    const over = await readAt(page, near.x + 1.2, near.y + SKY, near.z, "__dbgAimAssist");
    results.swordQuery = {
      up: beside.up,
      down: beside.down,
      beside: beside.inReach,
      above: over.inReach,
    };
    check(
      beside.inReach !== null,
      "nothing was in sword reach from 1.2 units away — the control failed, so the refusal below means nothing",
    );
    check(
      over.inReach === null,
      `the swing would still have been steered at an enemy ${SKY} units below ` +
        `(rise ${over.inReach?.rise})`,
    );

    // ---- and the swing itself, held aloft while it plays out --------------
    //
    // BOTH HALVES CARRY AN INSTRUMENT AND RETRY AN INVALID TRIAL (issue #186).
    // The holds are wall-clock intervals in a page the suite can starve, and a
    // starved hold desynchronises from the game's own clock: the hero sags off
    // the pin, the swing happens somewhere else, and the failure blamed
    // `inRise` for what was the harness slipping. Each attempt now records
    // what the hold actually held — the hero's lowest y aloft, the widest gap
    // on the ground — and a trial whose hold demonstrably slipped is restaged
    // rather than asserted on. A trial that HELD and still fails is a real
    // finding, and the instrument in the message says which kind it was.
    const hpOf = async (id) => {
      const b = await probe(page, "__dbgBodies");
      const e = b.enemies.find((q) => q.id === id && !q.isDead);
      return e?.hp ?? null;
    };
    const reacquire = async (from) => {
      const b = await probe(page, "__dbgBodies");
      return b.enemies.find((e) => e.id === from.id && !e.isDead);
    };

    // From the sky: pinned above it for the whole animation. Valid while the
    // hero never sagged within 6 of the ground — still far over any melee
    // band, so the refusal claim is intact for every height the trial saw.
    let air = null;
    const airTrials = [];
    for (let attempt = 0; attempt < 3 && air === null; attempt++) {
      const t = await reacquire(near);
      if (!t) {
        break;
      }
      await hover(page, t.x + 1.2, t.y + SKY, t.z, 500);
      const before = await hpOf(t.id);
      await setButton(B_RT, true);
      await wait(150);
      await setButton(B_RT, false);
      await wait(900);
      const after = await hpOf(t.id);
      const minY = await page.evaluate(() => window.__holdMinY ?? null);
      await release(page);
      // Valid while the hero never sagged within 6 of the ground — still far
      // over any melee band. A hit taken while the hold slipped says nothing
      // about the refusal band; a REFUSAL from a sagged hold is not a pass
      // either, so only a held trial counts in either direction.
      const held = minY !== null && minY - t.y >= 6;
      airTrials.push({ before, after, minY: minY === null ? null : +minY.toFixed(2), held });
      if (held && before !== null && after !== null) {
        air = { before, after, minY };
      }
    }

    // From the ground, beside it, facing it: the control. Reacquire immediately
    // before the swing. The wild enemy has been steering for the entire airborne
    // animation above; aiming at its several-seconds-old `near` coordinate made
    // this control depend on render timing and miss when issue #96 added two far
    // landscape draws, even though the reach query and combat code were unchanged.
    //
    // PIN THE HERO TO THE LIVE TARGET for the whole swing, the same way the
    // airborne half is pinned aloft — one teleport before the button and a fixed
    // wait was a race the target won as soon as it moved, and a wild beast now
    // breaks off between bites (issue #111) rather than standing still. Reading
    // its position each tick keeps the two 0.6 m apart whatever it does, so the
    // control measures the reach rule and not the animal's timing. The bearing
    // does not need re-aiming: the offset is constant, so it is.
    let ground = null;
    const groundTrials = [];
    for (let attempt = 0; attempt < 3 && ground === null; attempt++) {
      const t = await reacquire(near);
      if (!t) {
        break;
      }
      await page.evaluate((x, z) => window.__dbgTp(x, z), t.x + 0.6, t.z);
      await wait(400);
      await page.evaluate((b) => window.__dbgAim(b), Math.atan2(-1.2, 0));
      await wait(400);
      await page.evaluate((eid) => {
        window.__holdMaxD = 0.6;
        window.__holdTimer = setInterval(() => {
          const e = window.__dbgBodies().enemies.find((q) => q.id === eid && !q.isDead);
          if (e) {
            const p = window.__dbgPlayerPos();
            const d = Math.hypot(p.x - e.x, p.z - e.z);
            if (d > window.__holdMaxD) {
              window.__holdMaxD = d;
            }
            window.__dbgTp(e.x + 0.6, e.z);
          }
        }, 16);
      }, t.id);
      await wait(100);
      const before = await hpOf(t.id);
      await setButton(B_RT, true);
      await wait(150);
      await setButton(B_RT, false);
      await wait(900);
      const after = await hpOf(t.id);
      const maxD = await page.evaluate(() => window.__holdMaxD ?? null);
      await release(page);
      // A LANDED swing is a valid control whatever the gap read — the recorder
      // samples the beast mid-lunge between re-pins, and 1.7 with a hit is the
      // pin working. The gap only excuses a MISS: a miss with the pair apart is
      // the harness slipping and is restaged; a miss with the pair held tight
      // is the real finding. `after` null after a landed swing is the enemy
      // dying of it, which is a hit.
      const hit = before !== null && (after === null || after < before);
      const held = maxD !== null && maxD <= 1.5;
      groundTrials.push({ before, after, maxD: maxD === null ? null : +maxD.toFixed(2), held });
      if (hit) {
        ground = { before, after: after ?? 0, maxD };
      } else if (held) {
        ground = { before, after, maxD };
      }
    }

    results.swordOutcome = { airTrials, groundTrials };
    check(
      air !== null,
      `the airborne hold slipped in every trial — ${JSON.stringify(airTrials)} — ` +
        "the pin cannot keep the hero aloft on this host",
    );
    check(
      air === null || (air.before !== null && air.after !== null && air.after >= air.before),
      `a swing from ${SKY} units up (held, lowest y ${air?.minY?.toFixed?.(2)}) took an ` +
        `enemy on the ground from ${air?.before} to ${air?.after}`,
    );
    // The control. Wild enemies move, so a miss here is not necessarily a bug in
    // the game — but it does mean the pair above proved nothing, and a silent
    // pass is exactly what this file exists to prevent.
    check(
      ground !== null,
      `the ground pin slipped in every trial — ${JSON.stringify(groundTrials)} — ` +
        "the airborne refusal above is unproven, not passing",
    );
    check(
      ground === null ||
        (ground.before !== null && ground.after !== null && ground.after < ground.before),
      `the ground swing missed too (${ground?.before} -> ${ground?.after}, widest gap ` +
        `${ground?.maxD?.toFixed?.(2)}) — the airborne refusal above is unproven, not passing`,
    );
  }
}

console.log(JSON.stringify({ ...results, fails }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
