// Verifies gamepad support and the feedback layer it feeds.
//
// A real controller cannot be plugged into headless Brave, so the pad is
// SYNTHETIC: `evaluateOnNewDocument` replaces `navigator.getGamepads` before any
// module loads, and a `gamepadconnected` event is dispatched to wake the game's
// own listener. That runs the real code path end to end — connect handling,
// deadzones, the polling read, the arbitration in core/input.ts — and needs no
// test-only code in the shipped bundle, which is strictly better than the
// `__dbgTp` precedent (where the game had to grow a hook because nothing else
// could reach the state).
//
// The fake deliberately does NOT model `timestamp`: nothing in core/gamepad.ts
// reads it, and a fake that pretends to would be asserting on our own mock.
//
// Usage: bun tools/test-gamepad.mjs
import { launchBrowser, newPage, wait, installFakePad } from './browser.mjs';

const URL = 'http://localhost:5187/?fps=30&menu=0';

// Standard-mapping indices, mirrored from core/gamepad.ts.
const B = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, START: 9, L3: 10, R3: 11, DUP: 12, DDOWN: 13, DLEFT: 14, DRIGHT: 15 };

const setAxes = (page, ax) => page.evaluate((ax) => { window.__fakePad.axes = ax; }, ax);
const setButton = (page, i, down) => page.evaluate((i, down) => {
  window.__fakePad.buttons[i] = { pressed: down, touched: down, value: down ? 1 : 0 };
}, i, down);
const probe = (page, name) => page.evaluate((n) => window[n]?.(), name);

/**
 * Sum shortest-arc yaw deltas over a hold.
 *
 * `__dbgCamYaw` is an atan2 and wraps at ±π, which a single before/after diff
 * silently understates — on a GPU-fast host the camera passes half a circle
 * inside one hold. Same reasoning as tools/test-touch.mjs.
 */
async function accumulateYaw(page, ms) {
  let prev = await probe(page, '__dbgCamYaw');
  let total = 0;
  for (let i = 0; i < Math.max(1, Math.round(ms / 200)); i++) {
    await wait(200);
    const y = await probe(page, '__dbgCamYaw');
    if (prev !== undefined && y !== undefined) {
      let d = y - prev;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      total += Math.abs(d);
    }
    prev = y;
  }
  return total;
}

const browser = await launchBrowser();
const results = {};

// ---------- 1. no pad: nothing changes ----------
{
  const page = await newPage(browser, { width: 1280, height: 800 });
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await wait(3500);
  const input = await probe(page, '__dbgInput');
  results.noPad = {
    pad: await probe(page, '__dbgPad'),
    padActive: input?.padActive,
    // Every pre-existing key must still be there: test-touch.mjs dumps this
    // object wholesale, so a rename there is a break here.
    keepsExistingKeys: ['axisFwd', 'axisSide', 'lookActive', 'touchActive', 'onGround', 'isDead']
      .every((k) => input && k in input),
    feedbackPresent: (await probe(page, '__dbgFeedback')) !== null,
  };
  await page.close();
}

// ---------- 2. movement, look, deadzone, arbitration ----------
{
  const page = await newPage(browser, { width: 1280, height: 800 });
  await installFakePad(page, 'Xbox 360 Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)');
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await wait(3500);
  await page.evaluate(() => window.__connectPad());
  await wait(200);
  results.connect = await probe(page, '__dbgPad');

  // Deadzone: a stick resting inside it must produce nothing at all.
  await setAxes(page, [0.15, -0.15, 0.12, 0.12]);
  await wait(300);
  const dzYaw = await accumulateYaw(page, 600);
  results.deadzone = {
    stick: (await probe(page, '__dbgInput'))?.stick?.pad,
    yawDriftRadians: +dzYaw.toFixed(4),
  };

  // Move: hold the left stick forward. Distance over WALL-CLOCK, never per
  // frame — engine.tick() clamps dt and the host frame rate varies wildly.
  await setAxes(page, [0, -1, 0, 0]);
  await wait(300);
  const before = await probe(page, '__dbgPlayerPos');
  await wait(2500);
  const after = await probe(page, '__dbgPlayerPos');
  results.move = {
    stick: (await probe(page, '__dbgInput'))?.stick?.pad,
    movedUnits: +Math.hypot(after.x - before.x, after.z - before.z).toFixed(3),
  };

  // Arbitration: the keyboard must still win, and releasing it must hand the
  // axis back to the pad rather than zeroing it.
  await page.keyboard.down('w');
  await wait(250);
  const withKb = await probe(page, '__dbgInput');
  await page.keyboard.up('w');
  await wait(250);
  const padOnly = await probe(page, '__dbgInput');
  results.arbitration = {
    padStickHeldAt: +padOnly.stick.pad.fwd.toFixed(3),
    axisWithKeyboard: withKb.axisFwd,
    axisAfterRelease: +padOnly.axisFwd.toFixed(3),
    keyboardWins: withKb.axisFwd === 1,
    padResumes: Math.abs(padOnly.axisFwd - padOnly.stick.pad.fwd) < 1e-6,
  };
  await setAxes(page, [0, 0, 0, 0]);
  await wait(200);

  // Look: a pad player never clicks, so this also proves `lookActive` is true
  // without pointer lock. Asserted as a RATE, not a total.
  //
  // EXPECT ROUGHLY 2x the nominal 3.22 rad/s here, and that is not a gamepad
  // bug. `mouseDX` is cleared by endFrame() AFTER the slice loop, so every sim
  // slice in a frame applies the SAME accumulated look delta; this tool runs at
  // ?fps=30 against SIM_HZ 60, i.e. two slices per frame, so the turn lands
  // twice. Mouse look has always behaved this way below 60 fps — see the note
  // in the run summary. Asserted as a band wide enough to cover both.
  await setAxes(page, [0, 0, 1, 0]);
  await wait(200);
  const lookState = await probe(page, '__dbgInput');
  const yaw = await accumulateYaw(page, 2000);
  await setAxes(page, [0, 0, 0, 0]);
  await wait(200);

  // PITCH DIRECTION — inverted, and asserted so it cannot silently flip back.
  // The mouse's own mapping shipped first and read as backwards in the hand on
  // real hardware; core/gamepad.ts negates axis 3 for that reason.
  //
  // The stick is pushed UP (axis 3 reads +down, so up is -1) and the camera must
  // look DOWN. `__dbgCam().pitch` is the ELEVATION OF THE VIEW DIRECTION in
  // degrees (asin of dir.y), positive up — note that it moves OPPOSITE to
  // ThirdPersonCamera's own `pitch` field, which is an orbit angle that raises
  // the camera as it tips the view down. Held briefly, since the stick crosses
  // the whole clamp in well under a second.
  const elevBefore = (await probe(page, '__dbgCam'))?.pitch;
  await setAxes(page, [0, 0, 0, -1]);
  await wait(300);
  const elevAfter = (await probe(page, '__dbgCam'))?.pitch;
  await setAxes(page, [0, 0, 0, 0]);

  results.look = {
    lookActive: lookState?.lookActive,
    pointerLocked: await page.evaluate(() => document.pointerLockElement !== null),
    yawRadPerSec: +(yaw / 2).toFixed(3),
    viewElevationDeltaOnStickUp: +(elevAfter - elevBefore).toFixed(2),
    stickUpLooksDown: elevAfter < elevBefore,
  };

  // Buttons: A leaves the ground, D-pad up spends a skill, Y held mounts.
  await setButton(page, B.A, true);
  await wait(120);
  const jumpHeld = (await probe(page, '__dbgInput'))?.held?.Space;
  await wait(250);
  const airborne = !(await probe(page, '__dbgInput'))?.onGround;
  await setButton(page, B.A, false);
  await wait(900);

  await setButton(page, B.DUP, true);
  await wait(120);
  await setButton(page, B.DUP, false);
  await wait(200);
  const pressedDigits = (await probe(page, '__dbgInput'))?.pressedSince ?? [];

  await setButton(page, B.Y, true);
  await wait(1100);
  const mount = await probe(page, '__dbgMount');
  await setButton(page, B.Y, false);
  results.buttons = {
    jumpHeld,
    airborne,
    skillPressSeen: pressedDigits.includes('Digit1'),
    mountHold: mount?.hold ?? null,
    mounted: !!mount?.beast,
  };
  await page.close();
}

// ---------- 3. feedback: latency, i-frames, mixer cadence ----------
{
  const page = await newPage(browser, { width: 1280, height: 800 });
  await installFakePad(page, 'Xbox Wireless Controller', { rumble: true });
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await wait(3500);
  await page.evaluate(() => window.__connectPad());
  await wait(200);
  // A button press so the pad registers as in use, which is what unlocks the
  // gesture-gated channels.
  //
  // START, deliberately, NOT jump. Jumping here made the hero land in the
  // middle of the hurt sequence below, and `playerLanded` is itself a cue — so
  // the drained counter picked up a landing and the i-frame assertion reported
  // a blocked hit as having landed. The hero must be standing still and quiet
  // before anything counts cues.
  await setButton(page, B.START, true);
  await wait(120);
  await setButton(page, B.START, false);
  await wait(1200);

  // Driven entirely INSIDE the page. Sequencing this from the test process put
  // a CDP round-trip between each hurt and the next, and the hero's
  // invulnerability window is only 0.35 s — long enough that a slow round-trip
  // let the "blocked" hit through and the assertion reported the opposite of
  // the truth. In-page timers have no such jitter.
  const hurts = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const drained = () => window.__dbgFeedback().drained;
    const rumble = () => window.__rumble?.calls ?? 0;

    const a = drained();
    window.__dbgHurt(10);
    await sleep(120);
    const b = drained();
    const kindAfterFirst = window.__dbgFeedback().lastKind;

    // THE 'ONLY IF IT HITS' ASSERTION. Player.takeDamage refuses a hit inside
    // its 0.35 s invulnerability window, so this one must produce NO cue. Before
    // the onEnemyHit fix, the damage number, the burst, the screen flash — and
    // now a rumble — all fired on exactly this absorbed hit.
    window.__dbgHurt(10);
    await sleep(120);
    const c = drained();

    // ...and past the window it must land again, proving the gate above is a
    // gate and not the channel having gone quiet.
    await sleep(400);
    const rBeforeHit = rumble();
    window.__dbgHurt(10);
    await sleep(500);
    const d = drained();
    const rAfterHit = rumble();

    // Idle: with every envelope long decayed (the longest cue is 0.45 s), the
    // mixer must issue NOTHING. A per-frame re-issue would put this in the
    // hundreds, which is the whole reason the cadence exists.
    await sleep(1500);
    const rIdle = rumble();

    return {
      first: b - a,
      kindAfterFirst,
      blocked: c - b,
      afterWindow: d - c,
      rumbleCallsPerHit: rAfterHit - rBeforeHit,
      rumbleCallsWhileIdle: rIdle - rAfterHit,
    };
  });
  const fb = await probe(page, '__dbgFeedback');

  results.feedback = {
    mode: fb?.haptics?.mode,
    drainedOnFirstHurt: hurts.first,
    cueKindAfterFirstHurt: hurts.kindAfterFirst,
    drainedOnBlockedHurt: hurts.blocked,
    drainedAfterIFrames: hurts.afterWindow,
    rumbleCallsPerHit: hurts.rumbleCallsPerHit,
    rumbleCallsWhileIdle: hurts.rumbleCallsWhileIdle,
    audioSeamCalls: fb?.audio?.calls,
    lastKind: fb?.lastKind,
    dropped: fb?.dropped,
  };
  await page.close();
}

// ---------- 4. look inversion is a real switch ----------
//
// The defaults are asserted in section 2 (stick up looks down). This runs the
// same stick push with `?invy=0` and requires the camera to go the OTHER way —
// which is what separates a working setting from a hardcoded constant with a
// preference sitting unread beside it.
{
  const page = await newPage(browser, { width: 1280, height: 800 });
  await installFakePad(page, 'Xbox Wireless Controller');
  await page.goto(`${URL}&invy=0`, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await wait(3500);
  await page.evaluate(() => window.__connectPad());
  await wait(200);

  const before = (await probe(page, '__dbgCam'))?.pitch;
  await setAxes(page, [0, 0, 0, -1]);
  await wait(300);
  const after = (await probe(page, '__dbgCam'))?.pitch;
  await setAxes(page, [0, 0, 0, 0]);

  results.invertOverride = {
    reportedInvertY: (await probe(page, '__dbgPad'))?.invertLookY,
    viewElevationDeltaOnStickUp: +(after - before).toFixed(2),
    stickUpLooksUp: after > before,
  };
  await page.close();
}

// ---------- 5. glyph detection, and the ROUND TRIP back to the keyboard ------
//
// The assertion that matters here is a PAIR, and only the second half is new.
// A connected-but-untouched pad must not relabel a keyboard player's hotbar
// (that was always true), and a pad that HAS been used must hand the labels
// back the moment the keyboard is touched (issue #6 — it never did, because
// `padActive` is a latch and latches cannot un-set). Asserted on the hotbar
// badge and on the count of pad-shaped caps anywhere in the HUD, so a prompt
// that switches one and forgets the other cannot pass.
{
  const page = await newPage(browser, { width: 1280, height: 800 });
  await installFakePad(page, 'DualSense Wireless Controller (Vendor: 054c Product: 0ce6)');
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await wait(3000);
  await page.evaluate(() => window.__connectPad());
  await wait(200);

  const hotbar = () => page.evaluate(() => document.querySelector('.bs-slot .key')?.textContent);
  const padCaps = () => page.evaluate(() => document.querySelectorAll('.bs-root kbd.pad').length);
  const source = async () => (await probe(page, '__dbgInput'))?.lastSource;

  const beforeUse = { hotbar: await hotbar(), padCaps: await padCaps(), source: await source() };

  await setButton(page, B.START, true);
  await wait(150);
  await setButton(page, B.START, false);
  await wait(400);
  const onPad = { hotbar: await hotbar(), padCaps: await padCaps(), source: await source() };

  // Back to the keyboard. One keypress is the whole gesture — no pad
  // disconnect, nothing unplugged; the controller is still sitting there
  // connected, which is exactly the case that used to be stuck on faces.
  await page.keyboard.press('w');
  await wait(400);
  const onKeyboard = { hotbar: await hotbar(), padCaps: await padCaps(), source: await source() };

  // ...and back again, so this is a switch rather than a one-way door.
  await setButton(page, B.START, true);
  await wait(150);
  await setButton(page, B.START, false);
  await wait(400);
  const backOnPad = { hotbar: await hotbar(), padCaps: await padCaps(), source: await source() };

  results.glyphs = {
    dualsense: (await probe(page, '__dbgPad'))?.glyphs,
    beforeUse,
    onPad,
    onKeyboard,
    backOnPad,
    // The latch must survive the round trip: the start gate and the welcome
    // toast still ask "is there a controller player here", and that answer does
    // not become false because somebody typed.
    padActiveStillLatched: (await probe(page, '__dbgInput'))?.padActive,
  };
  await page.close();
}

// ---------- 6. rumble follows the hands, not the cable ----------------------
//
// The other half of issue #6. A controller left plugged in beside the keyboard
// used to buzz through a keyboard player's entire session, because the only
// question anyone asked was whether a pad was connected.
//
// The assertion is a PAIR for the same reason the i-frame test above is: the
// cue must still DRAIN while the player is on the keyboard (so this is a gate
// on the rumble, not the feedback channel having gone quiet) and must produce
// no rumble call — then rumble again the moment the pad is picked back up.
{
  const page = await newPage(browser, { width: 1280, height: 800 });
  await installFakePad(page, 'Xbox Wireless Controller', { rumble: true });
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await wait(3500);
  await page.evaluate(() => window.__connectPad());
  await wait(200);
  await setButton(page, B.START, true);
  await wait(120);
  await setButton(page, B.START, false);
  await wait(1200);

  // In-page for the same reason as section 3: the hero's invulnerability window
  // is 0.35 s and a CDP round-trip between hits is enough to swallow one.
  const hurt = () => page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const before = { drained: window.__dbgFeedback().drained, rumble: window.__rumble.calls };
    window.__dbgHurt(10);
    await sleep(600);
    return {
      drained: window.__dbgFeedback().drained - before.drained,
      rumbleCalls: window.__rumble.calls - before.rumble,
      tactileInput: window.__dbgFeedback().tactileInput,
    };
  });

  const onPad = await hurt();

  await page.keyboard.press('w');
  await wait(300);
  const onKeyboard = await hurt();

  await setButton(page, B.START, true);
  await wait(120);
  await setButton(page, B.START, false);
  await wait(300);
  const backOnPad = await hurt();

  results.rumbleSource = { onPad, onKeyboard, backOnPad };
  await page.close();
}

console.log(JSON.stringify(results, null, 2));
await browser.close();
