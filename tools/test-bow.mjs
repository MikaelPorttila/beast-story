// Issue #118, the PROJECTILE half: a bow FIRES, it is not a sword with a
// different model on it.
//
// Nothing in tools/ covered the bow at all before this — `arrowStrike`, the
// arrow model and main.ts's `player.weapon === 'bow'` branch all shipped
// unguarded — so a regression that quietly turned the bow back into a melee
// weapon would have been invisible to the suite.
//
// WHAT IS MEASURED, and why each is the measurement rather than the flag:
//
//   1. RANGED, not a slash. One attack press with the bow puts a projectile
//      whose `form` is 'arrow' in the air, and the SAME press with the iron
//      sword puts nothing in the air at all. The pool is shared with every
//      skill in the game, so `form` — not merely "a projectile exists" — is
//      what says the bow fired rather than something else did.
//   2. IT FLIES. The arrow's distance from the hero grows past `SWORD_REACH`
//      (2.2, src/combat/index.ts). "Ranged" is not a property of the model, it
//      is a distance, and this is the number that separates the two.
//   3. ONE PRESS, ONE ARROW. A bow draw is a single draw-and-release cycle,
//      not the sword's 3-hit combo, so a MASH inside one cycle still yields
//      exactly one arrow — while two presses a full cycle apart yield two, so
//      the count is proved to be a count and not a ceiling.
//   4. THE CROSSHAIR'S ELEVATION. Aimed up, the arrow climbs far above the
//      muzzle it left; aimed down, it meets the ground close in. Both halves,
//      because a shot that always climbs would pass the first on its own —
//      and the reported bug was a flat shot, which fails both.
//
// COUNTING ARROWS WITHOUT AN ID. `projectileSnapshot` hands back positions and
// no identity, so shots are counted by the one invariant an arrow has: it only
// ever gets FARTHER from the hero (no homing — see `arrowStrike`). A sample
// whose nearest arrow is closer than the previous sample's therefore contains
// an arrow that did not exist before, which is a release.
//
// THE CLOCK IS `__dbgAdvance`, not the wall clock: the whole probe is a few
// hundred simulated slices stepped synchronously, so nothing here depends on
// the frame rate the host happened to deliver. The pad is SYNTHETIC for the
// same reason as tools/test-aim-assist.mjs — RT is a button, so the attack can
// be pressed without taking pointer lock.
//
// Usage: bun tools/test-bow.mjs        (dev server must be up)
import {
  launchBrowser,
  newPage,
  logPageErrors,
  whenPlaying,
  installFakePad,
  setPadButton,
  PAD_BUTTON,
} from "./browser.mjs";
import { BASE as HOST, NO_WARMUP } from "./target.mjs";

// enemies and beasts off: an arrow that struck a wandering hunter would end its
// flight early and section 2 would read a short distance for the right reason
// and the wrong result. Nothing here measures a frame, so the shader sweep is
// skipped (see NO_WARMUP in tools/target.mjs).
const URL = `${HOST}/?menu=0&fs=0&vol=0&enemies=0&beasts=0&${NO_WARMUP}`;

/** src/combat/index.ts. The line between a swing and a shot. */
const SWORD_REACH = 2.2;
const BOW = "bow-ash";
const SWORD = "sword-iron";

const fails = [];
const check = (ok, what) => {
  if (!ok) {
    fails.push(what);
  }
  return ok;
};

async function equip(page, itemId) {
  return page.evaluate((id) => {
    window.__dbgGive(id, 1);
    window.__dbgInvAction(id, "equip");
    return window.__dbgShots().weapon;
  }, itemId);
}

/**
 * Press RT `presses` times, `gapS` simulated seconds apart, then watch the sky.
 *
 * Runs entirely inside the page so the sampling costs no CDP round trips: every
 * step is one `__dbgAdvance`, which is a burst of perfect 60 Hz slices.
 */
const fire = (page, { presses = 1, gapS = 0, steps = 60, step = 0.05 } = {}) =>
  page.evaluate(
    ({ presses, gapS, steps, step, btn }) => {
      const pad = window.__fakePad;
      const set = (down) => {
        pad.buttons[btn] = { pressed: down, touched: down, value: down ? 1 : 0 };
      };
      const arrows = () => {
        const h = window.__dbgPlayerPos();
        return window
          .__dbgShots()
          .shots.filter((s) => s.form === "arrow")
          .map((s) => Math.hypot(s.x - h.x, s.y - h.y, s.z - h.z));
      };

      let released = 0;
      let prevMin = Infinity;
      let maxDist = 0;
      let maxAloft = 0;
      let speed = 0;
      // Height of the arrow OVER THE HERO'S FEET, at its extremes. This is the
      // elevation of the shot as a measurement: the muzzle is 1.25 up, so a climb
      // reads well above that and a shot into the ground reads below it.
      let riseMax = -Infinity;
      let riseMin = Infinity;
      const table = [];
      // One sample: step the sim, then read what is in the air. `prevMin` only
      // ever rises for a given arrow, so a drop is a new one.
      const sample = (t) => {
        const d = arrows();
        const min = d.length ? Math.min(...d) : Infinity;
        if (min < prevMin - 0.01) {
          released += 1;
        }
        prevMin = min;
        if (d.length) {
          maxDist = Math.max(maxDist, Math.max(...d));
          maxAloft = Math.max(maxAloft, d.length);
          const s = window.__dbgShots().shots.find((x) => x.form === "arrow");
          speed = Math.max(speed, s ? s.speed : 0);
          if (s) {
            const rise = s.y - window.__dbgPlayerPos().y;
            riseMax = Math.max(riseMax, rise);
            riseMin = Math.min(riseMin, rise);
          }
        }
        table.push({
          t: +t.toFixed(2),
          aloft: d.length,
          nearest: d.length ? +min.toFixed(2) : null,
        });
      };

      let t = 0;
      for (let i = 0; i < presses; i++) {
        set(true);
        window.__dbgAdvance(step); // the press edge lands on slice one
        t += step;
        sample(t);
        set(false);
        if (i < presses - 1) {
          // Hold the gap in the same sampled steps, so an arrow released during
          // a mash is seen rather than skipped over.
          for (let k = 0; k < Math.max(1, Math.round(gapS / step)); k++) {
            window.__dbgAdvance(step);
            t += step;
            sample(t);
          }
        }
      }
      for (let i = 0; i < steps; i++) {
        window.__dbgAdvance(step);
        t += step;
        sample(t);
      }
      return {
        released,
        riseMax: riseMax === -Infinity ? null : +riseMax.toFixed(2),
        riseMin: riseMin === Infinity ? null : +riseMin.toFixed(2),
        maxDist: +maxDist.toFixed(2),
        maxAloft,
        topSpeed: +speed.toFixed(2),
        simSeconds: +t.toFixed(2),
        weapon: window.__dbgShots().weapon,
        table,
      };
    },
    { presses, gapS, steps, step, btn: PAD_BUTTON.RT },
  );

/** Park the hero in the open, away from the camp, and let the world settle. */
async function stand(page) {
  await page.evaluate(() => {
    const s = window.__dbgTowns().spawn;
    window.__dbgTp(s.x + 70, s.z + 70);
  });
  await page.waitForFunction(() => !window.__dbgZone().streaming, { timeout: 30000 });
  await page.evaluate(() => window.__dbgAdvance(1));
}

const browser = await launchBrowser();
const results = {};
try {
  const page = await newPage(browser, { width: 1280, height: 800 });
  logPageErrors(page);
  await installFakePad(page, "Xbox Wireless Controller");
  await page.goto(URL, { waitUntil: "load" });
  await whenPlaying(page);
  await page.evaluate(() => window.__connectPad());
  await stand(page);

  // ---------- 1. the bow shoots ---------------------------------------------
  const bowWeapon = await equip(page, BOW);
  check(bowWeapon === "bow", `equipping ${BOW} should hold a bow, held ${bowWeapon}`);
  const bow = await fire(page, { presses: 1 });
  results.bowOnePress = { ...bow, table: undefined };
  check(bow.released === 1, `one bow press should release 1 arrow, released ${bow.released}`);
  check(bow.maxAloft >= 1, "a bow press should put an arrow in the air");

  // ---------- 2. it is RANGED -----------------------------------------------
  // Not "a projectile existed" — a projectile that got further from the hero
  // than a sword could ever reach.
  results.flight = { maxDist: bow.maxDist, swordReach: SWORD_REACH, topSpeed: bow.topSpeed };
  check(
    bow.maxDist > SWORD_REACH,
    `the arrow should fly past SWORD_REACH ${SWORD_REACH}, got ${bow.maxDist}`,
  );

  // ---------- 3. the sword half of the pair ---------------------------------
  // The same press, the same page, the same hero: nothing in the air. Without
  // this, section 1 would also pass on a game that spawned an arrow for every
  // attack whatever was in hand.
  const swordWeapon = await equip(page, SWORD);
  check(swordWeapon === "sword", `equipping ${SWORD} should hold a sword, held ${swordWeapon}`);
  const sword = await fire(page, { presses: 1 });
  results.swordOnePress = { ...sword, table: undefined };
  check(sword.released === 0, `a sword press should release no arrow, released ${sword.released}`);
  check(sword.maxAloft === 0, `a sword press put ${sword.maxAloft} projectiles in the air`);

  // ---------- 4. one press, one arrow ---------------------------------------
  // A MASH inside one draw: six presses 0.1 s apart, which is well inside the
  // sword combo's 0.42 s first swing, so the melee path would queue and strike
  // three times. A bow draw is one cycle and answers with one arrow.
  await equip(page, BOW);
  const mash = await fire(page, { presses: 6, gapS: 0.1 });
  results.mash = { ...mash, presses: 6, gapS: 0.1, table: undefined };
  check(
    mash.released === 1,
    `six presses inside one draw should release 1 arrow (no melee combo), released ${mash.released}`,
  );

  // The other half: the counter can count. Two presses a full cycle apart are
  // two shots, so `released === 1` above is a bow that fired once and not a
  // probe that can only ever see one.
  const twice = await fire(page, { presses: 2, gapS: 2 });
  results.twoPresses = { ...twice, table: undefined };
  check(
    twice.released === 2,
    `two presses 2 s apart should release 2 arrows, released ${twice.released}`,
  );

  // ---------- 5. the shot takes the crosshair's ELEVATION --------------------
  // The reported bug: the arrow left at a fixed height whatever the camera was
  // pitched at, so there was no shooting up at anything and no shooting down
  // off a ledge. Measured as a HEIGHT the arrow reached, not as the aim vector
  // the code computed — and asserted in BOTH directions, because "it goes up
  // when I look up" is equally true of a shot that always climbs.
  //
  // The right stick pitches the camera, and `__dbgAdvance` polls the pad on
  // every slice it steps, so the sweep is simulated time and not wall clock.
  // Look UP is +y on stick 3 here: invertLookY defaults ON (tools/test-gamepad).
  //
  // AIMED AT A PITCH, not held for a duration: the camera's travel is clamped
  // at either end and the sweep starts from wherever the last section left it,
  // so "push the stick for 1.05 s" lands somewhere different every time it is
  // asked — first at -0.32 when -0.6 was wanted, then pinned at the -0.93
  // clamp. Pushing until the reading arrives is the same instrument the
  // assertions use.
  const aimTo = (goal) =>
    page.evaluate((goal) => {
      for (let i = 0; i < 120; i++) {
        const y = window.__dbgCam().dir.y;
        if (Math.abs(y - goal) < 0.04) {
          break;
        }
        window.__fakePad.axes[3] = y < goal ? 1 : -1;
        window.__dbgAdvance(0.05);
      }
      window.__fakePad.axes[3] = 0;
      window.__dbgAdvance(0.1);
      return window.__dbgCam().dir.y;
    }, goal);

  await equip(page, BOW);
  const upAim = await aimTo(0.5);
  const up = await fire(page, { presses: 1 });
  results.aimedUp = { camDirY: +upAim.toFixed(3), ...up, table: undefined };
  check(upAim > 0.15, `looking up should pitch the camera up, camera dir.y ${upAim}`);
  // Well above the 1.25 muzzle and still climbing at the end of the samples:
  // an arrow that merely left the bow at chest height cannot reach this.
  check(
    up.riseMax > 3,
    `aimed up, the arrow should climb well over the muzzle, peaked ${up.riseMax} over the feet`,
  );

  // A HALF-SWEEP DOWN, not the full one � and it starts from the UP pitch the
  // section above left behind, which is why it is longer than that sweep. At
  // the bottom of the camera's travel the arrow dies inside a single 0.05 s
  // sample and this would pass on having seen nothing at all, which is not the
  // same claim; this lands around -0.6, with room to watch the shot into the
  // ground.
  const downAim = await aimTo(-0.6);
  const down = await fire(page, { presses: 1 });
  results.aimedDown = { camDirY: +downAim.toFixed(3), ...down, table: undefined };
  check(downAim < -0.45, `looking down should pitch the camera down, camera dir.y ${downAim}`);
  // The other half, and it has to be watched rather than merely absent: the
  // arrow is released, seen, drops below the muzzle it left from, and meets the
  // ground far short of the shot that was aimed up.
  check(
    down.released === 1 &&
      down.riseMin !== null &&
      down.riseMin < 1 &&
      down.maxDist < up.maxDist / 2,
    `aimed down, the arrow should dive into the ground: released ${down.released}, ` +
      `floor ${down.riseMin} over the feet, reached ${down.maxDist} against ${up.maxDist} up`,
  );

  results.assertions = {
    bowFiresAnArrow: bow.released === 1 && bow.maxAloft >= 1,
    swordFiresNothing: sword.released === 0 && sword.maxAloft === 0,
    arrowOutrangesTheSword: bow.maxDist > SWORD_REACH,
    onePressOneArrow: mash.released === 1,
    twoPressesTwoArrows: twice.released === 2,
    aimUpFliesUp: up.riseMax > 3,
    aimDownHitsTheGround:
      down.released === 1 &&
      down.riseMin !== null &&
      down.riseMin < 1 &&
      down.maxDist < up.maxDist / 2,
  };
  await page.close();
} finally {
  await browser.close();
}

results.fails = fails;
console.log(JSON.stringify(results, null, 2));
if (fails.length) {
  console.error(`\nFAIL (${fails.length}):\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
console.log("\nbow: ok");
