// Verifies the LAYERED LOOK CHAIN — issue #2. Legs -> torso -> head, each joint
// limited relative to its PARENT, with the overflow running outward: past the
// head's limit the torso takes it, past the torso's limit the legs turn.
//
// The question this asks that nothing else could: "the hero faces where you
// aim" was already true and was true by turning his whole body, so a screenshot
// of him aiming proves nothing. What is new is that the halves of him can point
// in DIFFERENT directions at once — feet down the strafe, shoulders on the
// crosshair — and that is only visible in the three angles read apart. So every
// section here reads `__dbgLook`, which reports the base, each joint's offset
// from its own parent, and the crosshair, all signed and in degrees.
//
// STRAFING IS THE WHOLE FIXTURE. Movement is camera-relative, so a held W walks
// the hero exactly where he is aiming and the chain has nothing to do; the right
// stick pushed sideways is 90 degrees of disagreement between the feet and the
// shot, which is the case the issue names.
//
// The pad is SYNTHETIC, as in tools/test-aim-assist.mjs: RT is an attack this
// can hold without taking pointer lock, and the sticks give movement and look on
// the same clock as the frame the assertions are read from.
//
// Usage: bun tools/test-look.mjs        (dev server must be up)
import { launchBrowser, newPage, wait, logPageErrors } from './browser.mjs';
import { BASE as HOST } from './target.mjs';

const BASE = `${HOST}/?menu=0&fs=0&vol=0`;
const B_RT = 7;

/** The issue's constraints, in degrees. Asserted against the live config too. */
const TORSO_LIMIT = 45;
const HEAD_LIMIT = 75;
const PITCH_LIMIT = 40;
/** Float slack on an angle that has been damped toward a clamp. */
const EPS = 0.5;

const probe = (page, name) => page.evaluate((n) => window[n]?.(), name);
const setButton = (page, i, down) => page.evaluate((i, down) => {
  window.__fakePad.buttons[i] = { pressed: down, touched: down, value: down ? 1 : 0 };
}, i, down);
const setAxes = (page, axes) => page.evaluate((a) => {
  window.__fakePad.axes = a;
}, axes);
const look = (page, bearingDeg) =>
  page.evaluate((b) => window.__dbgAim((b * Math.PI) / 180), bearingDeg);
/**
 * Drain `seconds` of simulation NOW. Held pad state survives it (see the note
 * over `__dbgAdvance` in main.ts), so this is the same measurement a wall-clock
 * hold makes and it does not depend on the host's frame rate.
 */
const advance = (page, seconds) =>
  page.evaluate((s) => window.__dbgAdvance(s), seconds);

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

/** Shortest signed arc between two bearings in degrees. */
function arc(a, b) {
  let d = a - b;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

const results = {};
const browser = await launchBrowser();
const page = await newPage(browser, { width: 1280, height: 800 });
logPageErrors(page);
await installFakePad(page);
await page.goto(BASE, { waitUntil: 'load' });
await page.waitForSelector('canvas');
await wait(4000);
await page.evaluate(() => window.__connectPad());
await wait(200);

// ---------- 0. the limits the code is actually running with -----------------
//
// Read rather than assumed: the constants at the top of this file are the
// ISSUE, and this is the one line that ties them to the object under test. A
// retune that quietly halves the torso's reach fails here, on the number,
// instead of failing four sections later on a symptom.
{
  const l = (await probe(page, '__dbgLook')).limits;
  results.limits = {
    ...l,
    matchesIssue:
      l.torso === TORSO_LIMIT && l.head === HEAD_LIMIT && l.headPitch === PITCH_LIMIT,
  };
}

// ---------- 1. neutral when nothing is being tracked ------------------------
await look(page, 0);
await advance(page, 1.5);
{
  const l = await probe(page, '__dbgLook');
  results.atRest = {
    torsoDeg: l.torsoDeg,
    headDeg: l.headDeg,
    headPitchDeg: l.headPitchDeg,
    // Neutral means the joints are ON their parents, not merely small. 1.5
    // degrees is under a damped tail; anything the eye would call a twist is a
    // failure here.
    neutral:
      Math.abs(l.torsoDeg) < 1.5 && Math.abs(l.headDeg) < 1.5
      && Math.abs(l.headPitchDeg) < 1.5,
  };
}

// ---------- 2. strafing while aiming: the feet and the shoulders part ways ---
//
// Right stick parked, left stick hard right: the hero runs along the camera's
// RIGHT while the crosshair stays put, so the legs and the shot are 90 degrees
// apart. 90 is more than the torso alone may give (45) and less than the pair
// can reach (120), so the correct answer is unambiguous and is the shape of the
// whole feature: torso pinned AT its limit, head carrying the balance, and the
// two of them summing to the crosshair with the legs left out of it.
//
// Screen-right is `crosshair - 90` in this basis, not `+ 90`: bearings here are
// atan2(dx, dz), which runs the opposite way round from a screen-space "right".
// Measured, not assumed — the sign was wrong on the first run of this probe.
const samples = [];
const sample = async () => { samples.push(await probe(page, '__dbgLook')); };

await setButton(page, B_RT, true);
await setAxes(page, [1, 0, 0, 0]);
for (let i = 0; i < 8; i++) { await advance(page, 0.25); await sample(); }
{
  const l = samples[samples.length - 1];
  const strafeBearing = arc(l.crosshairDeg - 90, 0);
  results.strafingAim = {
    baseDeg: l.baseDeg,
    torsoDeg: l.torsoDeg,
    headDeg: l.headDeg,
    crosshairDeg: l.crosshairDeg,
    headWorldDeg: l.headWorldDeg,
    /** The legs are on the STRAFE, not on the shot. */
    baseOffStrafeDeg: +Math.abs(arc(l.baseDeg, strafeBearing)).toFixed(2),
    /** The head, at the end of the chain, IS on the shot. */
    headOffCrosshairDeg: +Math.abs(arc(l.headWorldDeg, l.crosshairDeg)).toFixed(2),
    legsFollowMovement: Math.abs(arc(l.baseDeg, strafeBearing)) < 8,
    torsoAtLimit: Math.abs(Math.abs(l.torsoDeg) - TORSO_LIMIT) < 2,
    headTakesTheBalance: Math.abs(Math.abs(l.headDeg) - 45) < 6,
    headOnCrosshair: Math.abs(arc(l.headWorldDeg, l.crosshairDeg)) < 8,
  };
}

// ---------- 3. head pitch, and its clamp ------------------------------------
//
// The camera pitches to 71.6 degrees down at its own stop, which is well past
// the head's 40, so this is the one axis where the clamp can be shown BITING
// rather than merely not being exceeded. Both stick directions are driven,
// because the sign convention between the camera arm and `head.rotation.x` is
// exactly the kind of thing that is right in one direction and inverted in the
// other.
const pitches = [];
for (const stick of [1, -1]) {
  await setAxes(page, [1, 0, 0, stick]);
  await advance(page, 2);
  const l = await probe(page, '__dbgLook');
  samples.push(l);
  pitches.push(l.headPitchDeg);
}
await setAxes(page, [1, 0, 0, 0]);
results.headPitch = {
  extremes: pitches,
  /** One end of the look range asks for more pitch than the head may give. */
  clampBites: Math.max(...pitches.map(Math.abs)) > PITCH_LIMIT - 1.5,
  /** Both signs are reached, so the axis is not stuck against one stop. */
  bothDirections: Math.min(...pitches) < -3 && Math.max(...pitches) > 3,
};

// ---------- 4. the legs catch up when the chain runs out of slack -----------
//
// Left stick hard BACK: the hero runs 180 degrees away from the crosshair, and
// 180 is more than the torso and the head can hold between them (45 + 75). The
// remainder has nowhere to go but the legs, so the base must settle somewhere
// between the movement direction and the shot instead of dead on the movement.
// That gap IS the catch-up, and section 2 — where the chain had slack and the
// base sat on the strafe — is the other half of the pair.
await setAxes(page, [0, 1, 0, 0]);
for (let i = 0; i < 8; i++) { await advance(page, 0.25); await sample(); }
{
  const l = samples[samples.length - 1];
  const backBearing = arc(l.crosshairDeg + 180, 0);
  const towardShot = Math.abs(arc(l.baseDeg, backBearing));
  results.baseCatchUp = {
    baseDeg: l.baseDeg,
    torsoDeg: l.torsoDeg,
    headDeg: l.headDeg,
    crosshairDeg: l.crosshairDeg,
    baseOffMovementDeg: +towardShot.toFixed(2),
    torsoSaturated: Math.abs(l.torsoDeg) > TORSO_LIMIT - 2,
    headSaturated: Math.abs(l.headDeg) > HEAD_LIMIT - 6,
    /** The feet gave ground — they are no longer on the movement direction. */
    legsTurnedToCatchUp: towardShot > 5,
  };
}

// ---------- 5. release: everything unwinds to neutral -----------------------
await setButton(page, B_RT, false);
await setAxes(page, [0, 0, 0, 0]);
await advance(page, 2.5);
{
  const l = await probe(page, '__dbgLook');
  samples.push(l);
  results.released = {
    torsoDeg: l.torsoDeg,
    headDeg: l.headDeg,
    headPitchDeg: l.headPitchDeg,
    returnedToNeutral:
      Math.abs(l.torsoDeg) < 2 && Math.abs(l.headDeg) < 2 && Math.abs(l.headPitchDeg) < 2,
  };
}

// ---------- 6. the constraints held over every frame sampled ----------------
//
// Not a spot check at the end: the limits are the contract, and a chain that
// overshoots on the way to a pose and settles inside it is still wrong. Every
// reading taken above goes through this.
{
  const worst = samples.reduce((w, l) => ({
    torso: Math.max(w.torso, Math.abs(l.torsoDeg)),
    head: Math.max(w.head, Math.abs(l.headDeg)),
    pitch: Math.max(w.pitch, Math.abs(l.headPitchDeg)),
  }), { torso: 0, head: 0, pitch: 0 });
  results.constraints = {
    samples: samples.length,
    worstTorsoDeg: +worst.torso.toFixed(2),
    worstHeadDeg: +worst.head.toFixed(2),
    worstPitchDeg: +worst.pitch.toFixed(2),
    withinLimits:
      worst.torso <= TORSO_LIMIT + EPS && worst.head <= HEAD_LIMIT + EPS
      && worst.pitch <= PITCH_LIMIT + EPS,
  };
}

await page.close();
// The browser keeps the event loop alive, so a probe that only exits on the
// FAILURE path hangs forever the first time it passes. (It did.)
await browser.close();

console.log(JSON.stringify(results, null, 2));

const failures = [];
const check = (name, ok) => { if (!ok) failures.push(name); };
check('limits match the issue', results.limits.matchesIssue);
check('neutral at rest', results.atRest.neutral);
check('legs follow movement while aiming', results.strafingAim.legsFollowMovement);
check('torso pinned at its limit', results.strafingAim.torsoAtLimit);
check('head takes the balance', results.strafingAim.headTakesTheBalance);
check('head ends on the crosshair', results.strafingAim.headOnCrosshair);
check('head pitch clamp bites', results.headPitch.clampBites);
check('head pitches both ways', results.headPitch.bothDirections);
check('torso saturates on a 180', results.baseCatchUp.torsoSaturated);
check('head saturates on a 180', results.baseCatchUp.headSaturated);
check('legs turn to catch up', results.baseCatchUp.legsTurnedToCatchUp);
check('unwinds to neutral', results.released.returnedToNeutral);
check('constraints never exceeded', results.constraints.withinLimits);

if (failures.length) {
  console.error(`\nFAIL: ${failures.join('; ')}`);
  process.exit(1);
}
console.error('\nok: look chain constrained, layered and released');
