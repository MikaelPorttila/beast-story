// Verifies gamepad support and the feedback layer it feeds.
//
// A real controller cannot be plugged into headless Brave, so the pad is
// SYNTHETIC: `navigator.getGamepads` is replaced before the game reads it, and a
// `gamepadconnected` event is dispatched to wake the game's own listener. That
// runs the real code path end to end — connect handling, deadzones, the polling
// read, the arbitration in core/input.ts — and needs no test-only code in the
// shipped bundle, which is strictly better than the `__dbgTp` precedent (where
// the game had to grow a hook because nothing else could reach the state).
//
// The fake deliberately does NOT model `timestamp`: nothing in core/gamepad.ts
// reads it, and a fake that pretends to would be asserting on our own mock.
//
// FAST-FORWARDED, SHARED-SESSION (~38 s of declared sleeps plus five boots
// before the conversion). `__dbgAdvance` polls the pad once per virtual slice
// (`pad?.poll(SIM_DT)` — see the hook in main.ts), so stick holds and button
// edges work under simulated time. Every yaw/position measurement runs INSIDE
// one `evaluate`, advancing synchronously — the shared page's real frame loop
// also polls the pad, and a measurement assembled across CDP round-trips would
// count that wall-clock look on top of the simulated seconds it divides by.
//
// PAGE-LEVEL POISON: the fake pad cannot be uninstalled and its first use flips
// `input.lastSource` to 'gamepad' and latches `padActive` for the page's life.
// In a suite this module runs LATE, and its `noPad` section runs FIRST and
// assumes no earlier module installed a pad.
//
// One REALTIME exception at the end: `lookRateVsFrameRate` compares the look
// rate ACROSS fps caps, and slices-per-rendered-frame is precisely what it
// guards (issue #37) — simulated time runs one poll per slice by construction
// and cannot reproduce the defect, so that section boots real pages at real
// caps and sleeps for real.
//
// Usage: bun tools/test-gamepad.mjs        (dev server must be up)
//        ...or as sections inside `bun tools/suite.mjs` — same code either way.
import { newPage, installFakePad } from './browser.mjs';
import { BASE as HOST } from './target.mjs';
import { advance, bondAll, unlockMounts } from './suite/harness.mjs';

/** Sleep for REAL milliseconds. Only the realtime section below may use it. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Standard-mapping indices, mirrored from core/gamepad.ts.
const B = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, START: 9, L3: 10, R3: 11, DUP: 12, DDOWN: 13, DLEFT: 14, DRIGHT: 15 };

const setAxes = (page, ax) => page.evaluate((a) => { window.__fakePad.axes = a; }, ax);
const setButton = (page, i, down) => page.evaluate((i, down) => {
  window.__fakePad.buttons[i] = { pressed: down, touched: down, value: down ? 1 : 0 };
}, i, down);
const probe = (page, name) => page.evaluate((n) => window[n]?.(), name);

/**
 * Runtime form of `installFakePad` for the ALREADY-BOOTED shared page.
 * `installFakePad` rides `evaluateOnNewDocument`, which only takes effect on a
 * navigation the shared page never performs — but nothing in core/gamepad.ts
 * caches the API, so swapping `navigator.getGamepads` live reaches the same
 * poll. Same state shape, same explicit `__connectPad`, same reasons (see
 * tools/browser.mjs).
 */
const installLivePad = (page, id, { rumble = false } = {}) => page.evaluate((id, rumble) => {
  const state = {
    id,
    index: 0,
    connected: true,
    mapping: 'standard',
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
  };
  if (rumble) {
    // Records calls so the mixer's re-issue cadence can be counted rather than
    // assumed. `effects` is the current spec spelling.
    window.__rumble = { calls: 0, last: null };
    state.vibrationActuator = {
      effects: ['dual-rumble'],
      playEffect: (type, params) => {
        window.__rumble.calls++;
        window.__rumble.last = { type, ...params };
        return Promise.resolve('complete');
      },
    };
  }
  window.__fakePad = state;
  navigator.getGamepads = () => [state];
  window.__connectPad = () => {
    const ev = new Event('gamepadconnected');
    Object.defineProperty(ev, 'gamepad', { value: state });
    window.dispatchEvent(ev);
  };
}, id, rumble);

/**
 * Sum shortest-arc yaw deltas over a SIMULATED hold, synchronously in-page.
 *
 * `__dbgCamYaw` is an atan2 and wraps at ±π, which a single before/after diff
 * silently understates — the camera passes half a circle inside one 2 s hold.
 * Same reasoning as tools/test-touch.mjs. Synchronous, because the real frame
 * loop also polls the pad: yaw accumulated across CDP round-trips would add
 * wall-clock turn on top of the simulated seconds the rate divides by.
 */
const yawOverSim = (page, s) => page.evaluate((secs) => {
  let prev = window.__dbgCamYaw();
  let total = 0;
  const steps = Math.max(1, Math.round(secs / 0.2));
  for (let i = 0; i < steps; i++) {
    window.__dbgAdvance(0.2);
    const y = window.__dbgCamYaw();
    let d = y - prev;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    total += Math.abs(d);
    prev = y;
  }
  return total;
}, s);

/**
 * Mark the pad as the live device, without a button. A short look-stick wiggle
 * runs the same `noteUse` path a button press does (core/gamepad.ts polls
 * `moving || looking` beside `anyPressed`), and unlike the old START press it
 * opens no menu — START now taps F10, and on a shared page the pause menu it
 * summons would have to be closed back through the modal branch before the next
 * section's keys mean anything.
 */
const padGesture = (page) => page.evaluate(() => {
  window.__fakePad.axes = [0, 0, 0.8, 0];
  window.__dbgAdvance(0.2);
  window.__fakePad.axes = [0, 0, 0, 0];
  window.__dbgAdvance(1.2);
});

/** Boot a PRIVATE page with the fake pad installed before any module loads. */
async function bootPadPage(bctx, id, { rumble = false, query = 'menu=0&fs=0' } = {}) {
  const page = await newPage(bctx, { width: 1280, height: 800 });
  await installFakePad(page, id, { rumble });
  await page.goto(`${HOST}/?${query}`, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await page.waitForFunction(
    () => window.__dbgBoot && window.__dbgBoot().playing && window.__dbgAdvance,
    { timeout: 60000 },
  );
  await page.evaluate(() => window.__connectPad());
  await advance(page, 0.2);
  return page;
}

export const name = 'gamepad';
export const sections = [

  // A BEAST TO MOUNT, AND THE UNLOCK TO MOUNT IT. A new game is bonded to
  // nothing and riding is locked, and the button section holds Y expecting a
  // mount. See `bondAll`.
  { id: 'party', run: async (ctx) => { await bondAll(ctx); await unlockMounts(ctx); } },

  // -------------------------------------------------------------------------
  { id: 'noPad', run: async (ctx) => {
    // No pad: nothing changes. MUST RUN BEFORE `stagePad` installs the fake —
    // the install is page-wide and permanent, so this is the one look at the
    // padless state the shared page gets.
    const input = await probe(ctx.page, '__dbgInput');
    const pad = await probe(ctx.page, '__dbgPad');
    ctx.res.noPad = {
      pad,
      padActive: input?.padActive,
      // Every pre-existing key must still be there: test-touch.mjs dumps this
      // object wholesale, so a rename there is a break here.
      keepsExistingKeys: ['axisFwd', 'axisSide', 'lookActive', 'touchActive', 'onGround', 'isDead']
        .every((k) => input && k in input),
      feedbackPresent: (await probe(ctx.page, '__dbgFeedback')) !== null,
    };
    ctx.check(ctx.res.noPad.keepsExistingKeys,
      'a key test-touch.mjs depends on has vanished from __dbgInput');
    ctx.check(!input?.padActive, 'padActive is latched on a page no pad has touched');
    ctx.check(!pad?.connected, 'a pad reports connected before any was installed');
    ctx.check(ctx.res.noPad.feedbackPresent, 'the feedback layer is missing without a pad');
  } },

  // -------------------------------------------------------------------------
  { id: 'stagePad', run: async (ctx) => {
    // Open ground first: the session starts inside the walled camp, and the
    // move section below drives a straight line. Then the fake pad, WITH the
    // rumble actuator — the original's movement page had none, but an actuator
    // that merely exists changes nothing section 2 measured. (The feedback and
    // rumbleSource sections now measure on private pages — see their
    // composition notes — but the actuator stays: it cannot be swapped later
    // and its presence is part of what the shared page's pad path exercises.)
    const openGround = await ctx.ev(() => window.__dbgTowns().spawn);
    await ctx.tp(openGround.x, openGround.z);
    const settled = await ctx.settleStreaming(30);
    ctx.check(settled, 'the streamer never settled after the teleport');
    await ctx.adv(1);

    await installLivePad(ctx.page, 'Xbox 360 Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)', { rumble: true });
    await ctx.ev(() => window.__connectPad());
    await ctx.adv(0.2);
    ctx.res.connect = await probe(ctx.page, '__dbgPad');
    ctx.check(ctx.res.connect?.connected === true, 'the fake pad never connected');
    ctx.check(ctx.res.connect?.glyphs === 'xbox',
      `an Xbox id chose the ${ctx.res.connect?.glyphs} glyph set`);
  } },

  // -------------------------------------------------------------------------
  { id: 'deadzone', run: async (ctx) => {
    // A stick resting inside the deadzone must produce nothing at all.
    await setAxes(ctx.page, [0.15, -0.15, 0.12, 0.12]);
    // SETTLE THE CAMERA FIRST, and it is a COMPOSITION fix rather than padding.
    // The follow rig eases toward its target with `1 - exp(-lambda*dt)`, so a
    // camera still catching up from whatever the previous module left the hero
    // doing keeps turning on its own for a second or so — measured 0.0254 rad
    // over the old fixed 0.3 s lead-in, against a 0.02 bound, which failed the
    // deadzone on a stick that was correctly reporting 0/0. Solo there was
    // nothing to catch up from and it never showed. Advancing until the yaw
    // itself is quiet removes the confound instead of widening the bound to
    // tolerate it — the assertion is about the STICK, so the camera has to be
    // still before the stick can be blamed for moving it.
    for (let i = 0; i < 15; i++) {
      if (await yawOverSim(ctx.page, 0.2) < 0.002) break;
    }
    const dzYaw = await yawOverSim(ctx.page, 0.6);
    ctx.res.deadzone = {
      stick: (await probe(ctx.page, '__dbgInput'))?.stick?.pad,
      yawDriftRadians: +dzYaw.toFixed(4),
    };
    ctx.check(ctx.res.deadzone.stick?.fwd === 0 && ctx.res.deadzone.stick?.side === 0,
      `a stick inside the deadzone still reports ${JSON.stringify(ctx.res.deadzone.stick)}`);
    ctx.check(dzYaw < 0.02,
      `a look stick inside the deadzone turned the camera ${+dzYaw.toFixed(4)} rad`);
    await setAxes(ctx.page, [0, 0, 0, 0]);
  } },

  // -------------------------------------------------------------------------
  { id: 'move', run: async (ctx) => {
    // Hold the left stick forward. Distance over SIMULATED seconds, measured
    // inside one evaluate so the real frame loop's own walking (it polls the
    // pad too) cannot pad the figure between round-trips.
    await setAxes(ctx.page, [0, -1, 0, 0]);
    await ctx.adv(0.3);
    const run = await ctx.ev(() => {
      const before = window.__dbgPlayerPos();
      window.__dbgAdvance(2.5);
      const after = window.__dbgPlayerPos();
      return { moved: Math.hypot(after.x - before.x, after.z - before.z) };
    });
    ctx.res.move = {
      stick: (await probe(ctx.page, '__dbgInput'))?.stick?.pad,
      movedUnits: +run.moved.toFixed(3),
    };
    ctx.check(run.moved > 5,
      `a full stick hold moved the hero ${+run.moved.toFixed(2)} units in 2.5 s`);
  } },

  // -------------------------------------------------------------------------
  { id: 'arbitration', run: async (ctx) => {
    // The keyboard must still win, and releasing it must hand the axis back to
    // the pad rather than zeroing it.
    await setAxes(ctx.page, [0, -1, 0, 0]);
    await ctx.adv(0.3);
    await ctx.page.keyboard.down('KeyW');
    await ctx.adv(0.25);
    const withKb = await probe(ctx.page, '__dbgInput');
    await ctx.page.keyboard.up('KeyW');
    await ctx.adv(0.25);
    const padOnly = await probe(ctx.page, '__dbgInput');
    ctx.res.arbitration = {
      padStickHeldAt: +padOnly.stick.pad.fwd.toFixed(3),
      axisWithKeyboard: withKb.axisFwd,
      axisAfterRelease: +padOnly.axisFwd.toFixed(3),
      keyboardWins: withKb.axisFwd === 1,
      padResumes: Math.abs(padOnly.axisFwd - padOnly.stick.pad.fwd) < 1e-6,
    };
    ctx.check(ctx.res.arbitration.keyboardWins,
      `with W held the forward axis reads ${withKb.axisFwd}, not the keyboard's 1`);
    ctx.check(ctx.res.arbitration.padResumes,
      `releasing the keyboard left the axis at ${ctx.res.arbitration.axisAfterRelease} `
      + `against a stick still holding ${ctx.res.arbitration.padStickHeldAt}`);
    await setAxes(ctx.page, [0, 0, 0, 0]);
    await ctx.adv(0.2);
  } },

  // -------------------------------------------------------------------------
  { id: 'look', run: async (ctx) => {
    // A pad player never clicks, so this also proves `lookActive` is true
    // without pointer lock. Asserted as a RATE, not a total.
    //
    // EXPECT THE NOMINAL 3.22 rad/s. It used to read roughly 2x here and that
    // was never a gamepad bug: `mouseDX` was cleared by endFrame() AFTER the
    // slice loop, so every sim slice in a frame re-applied the SAME accumulated
    // delta. That is issue #37, fixed in Input.takeLook; the realtime section
    // at the end is the guard that keeps it so, and under `__dbgAdvance` (one
    // poll per slice by construction) the nominal is what a correct pipeline
    // MUST read.
    await setAxes(ctx.page, [0, 0, 1, 0]);
    await ctx.adv(0.2);
    const lookState = await probe(ctx.page, '__dbgInput');
    const yaw = await yawOverSim(ctx.page, 2);
    await setAxes(ctx.page, [0, 0, 0, 0]);
    await ctx.adv(0.2);

    // PITCH DIRECTION — inverted, and asserted so it cannot silently flip back.
    // The mouse's own mapping shipped first and read as backwards in the hand on
    // real hardware; core/gamepad.ts negates axis 3 for that reason.
    //
    // The stick is pushed UP (axis 3 reads +down, so up is -1) and the camera
    // must look DOWN. `__dbgCam().pitch` is the ELEVATION OF THE VIEW DIRECTION
    // in degrees (asin of dir.y), positive up — note that it moves OPPOSITE to
    // ThirdPersonCamera's own `pitch` field, which is an orbit angle that raises
    // the camera as it tips the view down. Held briefly, since the stick crosses
    // the whole clamp in well under a second.
    const elevBefore = (await probe(ctx.page, '__dbgCam'))?.pitch;
    await setAxes(ctx.page, [0, 0, 0, -1]);
    await ctx.adv(0.3);
    const elevAfter = (await probe(ctx.page, '__dbgCam'))?.pitch;
    await setAxes(ctx.page, [0, 0, 0, 0]);

    ctx.res.look = {
      lookActive: lookState?.lookActive,
      pointerLocked: await ctx.ev(() => document.pointerLockElement !== null),
      yawRadPerSec: +(yaw / 2).toFixed(3),
      viewElevationDeltaOnStickUp: +(elevAfter - elevBefore).toFixed(2),
      stickUpLooksDown: elevAfter < elevBefore,
    };
    ctx.check(ctx.res.look.lookActive === true, 'lookActive is false under a held look stick');
    ctx.check(ctx.res.look.pointerLocked === false,
      'the page holds pointer lock — the lookActive result above proves nothing');
    ctx.check(Math.abs(ctx.res.look.yawRadPerSec - 3.22) < 0.4,
      `full deflection turned ${ctx.res.look.yawRadPerSec} rad/s against the nominal 3.22`);
    ctx.check(ctx.res.look.stickUpLooksDown,
      `stick up moved the view elevation by ${ctx.res.look.viewElevationDeltaOnStickUp} — `
      + 'the default pad Y inversion has flipped back');
  } },

  // -------------------------------------------------------------------------
  { id: 'buttons', run: async (ctx) => {
    // A leaves the ground, D-pad up spends a skill, Y held mounts.
    await setButton(ctx.page, B.A, true);
    await ctx.adv(0.12);
    const jumpHeld = (await probe(ctx.page, '__dbgInput'))?.held?.Space;
    await ctx.adv(0.25);
    const airborne = !(await probe(ctx.page, '__dbgInput'))?.onGround;
    await setButton(ctx.page, B.A, false);
    await ctx.adv(0.9);

    await setButton(ctx.page, B.DUP, true);
    await ctx.adv(0.12);
    await setButton(ctx.page, B.DUP, false);
    await ctx.adv(0.2);
    // `pressedSince` is a latch cleared by every __dbgInput read — the jump
    // reads above emptied it, so what this read returns arrived after them.
    const pressedDigits = (await probe(ctx.page, '__dbgInput'))?.pressedSince ?? [];

    await setButton(ctx.page, B.Y, true);
    await ctx.adv(1.1);
    const mount = await probe(ctx.page, '__dbgMount');
    await setButton(ctx.page, B.Y, false);
    ctx.res.buttons = {
      jumpHeld,
      airborne,
      skillPressSeen: pressedDigits.includes('Digit1'),
      mountHold: mount?.hold ?? null,
      mounted: !!mount?.beast,
    };
    ctx.check(jumpHeld === true, 'a held A never registered as a held Space');
    ctx.check(airborne, 'a held A never left the ground');
    ctx.check(ctx.res.buttons.skillPressSeen,
      `D-pad up tapped no Digit1 (pressedSince: ${JSON.stringify(pressedDigits)})`);
    ctx.check(ctx.res.buttons.mounted, 'a held Y never mounted');
    // Hand the saddle back before anything else measures the hero.
    await ctx.adv(0.3);
    await ctx.ev(() => window.__dbgRide('off'));
    await ctx.adv(0.3);
  } },

  // -------------------------------------------------------------------------
  { id: 'feedback', run: async (ctx) => {
    // Latency, i-frames, mixer cadence.
    //
    // A PRIVATE PAGE — COMPOSITION FIX. These exact counters passed solo and
    // failed in the suite: by the time this module runs, four modules of play
    // have aged the shared world and its feedback channel is no longer quiet.
    // The composed run measured `lastKind: "pickup"`, 3 cues drained on one
    // landed hit and 4 rumble calls over 1.5 idle seconds — ambient cues
    // (pickups reaching the hero, the aged world's own events) draining into
    // the windows these deltas read. The counts are exact by design and get
    // the quiet world they were written against: a fresh page whose only cue
    // source is this section. `bootPadPage` installs the same rumble-recording
    // actuator the shared-page install carries.
    //
    // The pad has to register as in use first, which is what unlocks the
    // gesture-gated channels. A stick wiggle, deliberately NOT jump: jumping
    // here made the hero land in the middle of the hurt sequence below, and
    // `playerLanded` is itself a cue — so the drained counter picked up a
    // landing and the i-frame assertion reported a blocked hit as having
    // landed. The hero must be standing still and quiet before anything counts
    // cues.
    const bctx = await ctx.page.browser().createBrowserContext();
    try {
    const page = await bootPadPage(bctx,
      'Xbox 360 Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)', { rumble: true });
    await padGesture(page);

    // Driven entirely INSIDE the page, synchronously. Sequencing this from the
    // test process put a CDP round-trip between each hurt and the next, and the
    // hero's invulnerability window is only 0.35 s — long enough that a slow
    // round-trip let the "blocked" hit through and the assertion reported the
    // opposite of the truth. `__dbgAdvance` between the hits has no jitter at
    // all: no real frame can run inside one evaluate.
    const hurts = await page.evaluate(() => {
      const adv = (s) => window.__dbgAdvance(s);
      const drained = () => window.__dbgFeedback().drained;
      const rumble = () => window.__rumble?.calls ?? 0;

      const a = drained();
      window.__dbgHurt(10);
      adv(0.12);
      const b = drained();
      const kindAfterFirst = window.__dbgFeedback().lastKind;

      // THE 'ONLY IF IT HITS' ASSERTION. Player.takeDamage refuses a hit inside
      // its 0.35 s invulnerability window, so this one must produce NO cue.
      // Before the onEnemyHit fix, the damage number, the burst, the screen
      // flash — and now a rumble — all fired on exactly this absorbed hit.
      window.__dbgHurt(10);
      adv(0.12);
      const c = drained();

      // ...and past the window it must land again, proving the gate above is a
      // gate and not the channel having gone quiet.
      adv(0.4);
      const rBeforeHit = rumble();
      window.__dbgHurt(10);
      adv(0.5);
      const d = drained();
      const rAfterHit = rumble();

      // Idle: with every envelope long decayed (the longest cue is 0.45 s), the
      // mixer must issue NOTHING. A per-slice re-issue would put this near 90,
      // which is the whole reason the cadence exists.
      //
      // THE WINDOW HAS TO BE GENUINELY IDLE, and that stopped being free. The
      // hero is standing in a meadow with a wild population in it, and one bite
      // inside the window is a REAL cue — four rumble calls, which is exactly
      // what a mixer that issued four would look like. So a window with anything
      // drained in it is thrown away and retaken, rather than the assertion
      // being loosened to a number a re-issue could also pass. `idleClean` says
      // whether a quiet one was ever obtained, so a permanently busy world gets
      // reported instead of quietly passing.
      let idleCalls = 0;
      let idleClean = false;
      let idleTries = 0;
      for (; idleTries < 6 && !idleClean; idleTries++) {
        const dBefore = drained();
        const rBefore = rumble();
        adv(1.5);
        idleCalls = rumble() - rBefore;
        idleClean = drained() === dBefore;
      }

      return {
        first: b - a,
        kindAfterFirst,
        blocked: c - b,
        afterWindow: d - c,
        rumbleCallsPerHit: rAfterHit - rBeforeHit,
        rumbleCallsWhileIdle: idleCalls,
        idleClean,
        idleTries,
      };
    });
    const fb = await probe(page, '__dbgFeedback');

    ctx.res.feedback = {
      mode: fb?.haptics?.mode,
      drainedOnFirstHurt: hurts.first,
      cueKindAfterFirstHurt: hurts.kindAfterFirst,
      drainedOnBlockedHurt: hurts.blocked,
      drainedAfterIFrames: hurts.afterWindow,
      rumbleCallsPerHit: hurts.rumbleCallsPerHit,
      rumbleCallsWhileIdle: hurts.rumbleCallsWhileIdle,
      idleWindowWasQuiet: hurts.idleClean,
      idleWindowTries: hurts.idleTries,
      audioSeamCalls: fb?.audio?.calls,
      lastKind: fb?.lastKind,
      dropped: fb?.dropped,
    };
    ctx.check(fb?.haptics?.mode === 'dual-rumble',
      `the rumble pad resolved to mode ${fb?.haptics?.mode}`);
    ctx.check(hurts.first === 1, `the first hurt drained ${hurts.first} cues, expected 1`);
    ctx.check(hurts.blocked === 0,
      `a hit inside the invulnerability window drained ${hurts.blocked} cues`);
    ctx.check(hurts.afterWindow === 1,
      `past the window the hit drained ${hurts.afterWindow} cues — the gate never re-opened`);
    ctx.check(hurts.rumbleCallsPerHit >= 1,
      `a landed hit issued ${hurts.rumbleCallsPerHit} rumble calls`);
    // <= 1, not 0: the mixer issues one explicit zero when the last envelope
    // decays, and depending on where the 0.5 s window cut it that zero may fall
    // in the idle stretch instead.
    // BOTH HALVES. The count is the claim; `idleClean` is what says the window
    // it was counted over was quiet — without it, "0 calls" could be six
    // windows that each had a bite in them and a reader would never know.
    ctx.check(hurts.idleClean,
      `no quiet 1.5 s window in ${hurts.idleTries} tries — something kept hitting the hero`);
    ctx.check(hurts.rumbleCallsWhileIdle <= 1,
      `${hurts.rumbleCallsWhileIdle} rumble calls over 1.5 idle seconds — the mixer re-issues`);
    } finally {
      await bctx.close();
    }
  } },

  // -------------------------------------------------------------------------
  { id: 'rumbleSource', run: async (ctx) => {
    // Rumble follows the hands, not the cable — the other half of issue #6. A
    // controller left plugged in beside the keyboard used to buzz through a
    // keyboard player's entire session, because the only question anyone asked
    // was whether a pad was connected.
    //
    // The assertion is a PAIR for the same reason the i-frame test above is:
    // the cue must still DRAIN while the player is on the keyboard (so this is
    // a gate on the rumble, not the feedback channel having gone quiet) and
    // must produce no rumble call — then rumble again the moment the pad is
    // picked back up.
    //
    // In-page and synchronous for the same reason as `feedback`: the 0.35 s
    // invulnerability window does not survive CDP jitter.
    //
    // A PRIVATE PAGE — same COMPOSITION FIX as `feedback`, same evidence: the
    // shared world's ambient cues drain into the exact `drained === 1` counts
    // this pair reads, so the switch is measured on a page where a hurt is the
    // only cue source there is.
    const bctx = await ctx.page.browser().createBrowserContext();
    try {
    const page = await bootPadPage(bctx,
      'Xbox 360 Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)', { rumble: true });
    const hurt = () => page.evaluate(() => {
      const before = { drained: window.__dbgFeedback().drained, rumble: window.__rumble.calls };
      window.__dbgHurt(10);
      window.__dbgAdvance(0.6);
      return {
        drained: window.__dbgFeedback().drained - before.drained,
        rumbleCalls: window.__rumble.calls - before.rumble,
        tactileInput: window.__dbgFeedback().tactileInput,
      };
    });

    await padGesture(page);
    const onPad = await hurt();

    // Back to the keyboard. One keypress is the whole gesture — no pad
    // disconnect, nothing unplugged; the controller is still sitting there
    // connected, which is exactly the case that used to be stuck buzzing.
    await page.keyboard.press('KeyW');
    await advance(page, 0.3);
    const onKeyboard = await hurt();

    // ...and back again, so this is a switch rather than a one-way door.
    await padGesture(page);
    const backOnPad = await hurt();

    ctx.res.rumbleSource = { onPad, onKeyboard, backOnPad };
    ctx.check(onPad.drained === 1 && onPad.rumbleCalls >= 1,
      `on the pad, a hit drained ${onPad.drained} cues and issued ${onPad.rumbleCalls} rumble calls`);
    ctx.check(onKeyboard.drained === 1,
      `on the keyboard the cue did not drain (${onKeyboard.drained}) — the rumble silence below proves nothing`);
    ctx.check(onKeyboard.rumbleCalls === 0,
      `${onKeyboard.rumbleCalls} rumble calls reached a pad nobody is holding`);
    ctx.check(backOnPad.rumbleCalls >= 1,
      `picking the pad back up restored no rumble (${backOnPad.rumbleCalls} calls)`);
    } finally {
      await bctx.close();
    }
  } },

  // -------------------------------------------------------------------------
  { id: 'invertOverride', run: async (ctx) => {
    // Look inversion is a real switch. The defaults are asserted in `look`
    // (stick up looks down). This runs the same stick push with `?invy=0` and
    // requires the camera to go the OTHER way — which is what separates a
    // working setting from a hardcoded constant with a preference sitting
    // unread beside it.
    //
    // A PRIVATE PAGE, necessarily: `invy` is a one-load boot flag (never
    // persisted), so it only exists on a fresh boot.
    const bctx = await ctx.page.browser().createBrowserContext();
    try {
      const page = await bootPadPage(bctx, 'Xbox Wireless Controller', { query: 'menu=0&fs=0&invy=0' });
      const before = (await probe(page, '__dbgCam'))?.pitch;
      await setAxes(page, [0, 0, 0, -1]);
      await advance(page, 0.3);
      const after = (await probe(page, '__dbgCam'))?.pitch;
      await setAxes(page, [0, 0, 0, 0]);

      ctx.res.invertOverride = {
        reportedInvertY: (await probe(page, '__dbgPad'))?.invertLookY,
        viewElevationDeltaOnStickUp: +(after - before).toFixed(2),
        stickUpLooksUp: after > before,
      };
      ctx.check(ctx.res.invertOverride.reportedInvertY === false,
        `?invy=0 left invertLookY at ${ctx.res.invertOverride.reportedInvertY}`);
      ctx.check(ctx.res.invertOverride.stickUpLooksUp,
        `with ?invy=0 stick up moved the view ${ctx.res.invertOverride.viewElevationDeltaOnStickUp} — `
        + 'the preference is not read');
    } finally {
      await bctx.close();
    }
  } },

  // -------------------------------------------------------------------------
  { id: 'glyphs', run: async (ctx) => {
    // Glyph detection, and the ROUND TRIP back to the keyboard.
    //
    // The assertion that matters here is a PAIR, and only the second half is
    // new. A connected-but-untouched pad must not relabel a keyboard player's
    // hotbar (that was always true), and a pad that HAS been used must hand the
    // labels back the moment the keyboard is touched (issue #6 — it never did,
    // because `padActive` is a latch and latches cannot un-set). Asserted on
    // the hotbar badge and on the count of pad-shaped caps anywhere in the HUD,
    // so a prompt that switches one and forgets the other cannot pass.
    //
    // A PRIVATE PAGE, necessarily: `beforeUse` needs a pad nobody has touched,
    // and the shared page's pad has been driven by every section above. START
    // is kept as the pad gesture here (it exercises the button path of
    // `noteUse`), and its menu toggles openly: first press opens the pause
    // menu, second closes it, and the page is private so nothing downstream
    // inherits either state.
    const bctx = await ctx.page.browser().createBrowserContext();
    try {
      const page = await bootPadPage(bctx, 'DualSense Wireless Controller (Vendor: 054c Product: 0ce6)');
      const hotbar = () => page.evaluate(() => document.querySelector('.bs-slot .key')?.textContent);
      const padCaps = () => page.evaluate(() => document.querySelectorAll('.bs-root kbd.pad').length);
      const source = async () => (await probe(page, '__dbgInput'))?.lastSource;

      const beforeUse = { hotbar: await hotbar(), padCaps: await padCaps(), source: await source() };

      await setButton(page, B.START, true);
      await advance(page, 0.15);
      await setButton(page, B.START, false);
      await advance(page, 0.4);
      const onPad = { hotbar: await hotbar(), padCaps: await padCaps(), source: await source() };

      // Back to the keyboard. One keypress is the whole gesture — no pad
      // disconnect, nothing unplugged; the controller is still sitting there
      // connected, which is exactly the case that used to be stuck on faces.
      await page.keyboard.press('KeyW');
      await advance(page, 0.4);
      const onKeyboard = { hotbar: await hotbar(), padCaps: await padCaps(), source: await source() };

      // ...and back again, so this is a switch rather than a one-way door.
      await setButton(page, B.START, true);
      await advance(page, 0.15);
      await setButton(page, B.START, false);
      await advance(page, 0.4);
      const backOnPad = { hotbar: await hotbar(), padCaps: await padCaps(), source: await source() };

      ctx.res.glyphs = {
        dualsense: (await probe(page, '__dbgPad'))?.glyphs,
        beforeUse,
        onPad,
        onKeyboard,
        backOnPad,
        // The latch must survive the round trip: the start gate and the welcome
        // toast still ask "is there a controller player here", and that answer
        // does not become false because somebody typed.
        padActiveStillLatched: (await probe(page, '__dbgInput'))?.padActive,
      };
      ctx.check(ctx.res.glyphs.dualsense === 'playstation',
        `a DualSense id chose the ${ctx.res.glyphs.dualsense} glyph set`);
      ctx.check(beforeUse.padCaps === 0,
        `${beforeUse.padCaps} pad caps in the HUD before the pad was ever touched`);
      ctx.check(onPad.padCaps > 0 && onPad.source === 'gamepad',
        `after a pad press the HUD shows ${onPad.padCaps} pad caps (source ${onPad.source})`);
      ctx.check(onPad.hotbar !== beforeUse.hotbar,
        `the hotbar badge never left its keyboard label ("${onPad.hotbar}")`);
      ctx.check(onKeyboard.padCaps === 0,
        `${onKeyboard.padCaps} pad caps still shown after the keyboard was touched (issue #6)`);
      ctx.check(onKeyboard.hotbar === beforeUse.hotbar,
        `the hotbar badge did not hand back to the keyboard ("${onKeyboard.hotbar}")`);
      ctx.check(backOnPad.padCaps > 0 && backOnPad.source === 'gamepad',
        `returning to the pad restored ${backOnPad.padCaps} pad caps (source ${backOnPad.source})`);
      ctx.check(ctx.res.glyphs.padActiveStillLatched === true,
        'padActive un-latched over the round trip — the start gate would forget its controller player');
    } finally {
      await bctx.close();
    }
  } },

  // -------------------------------------------------------------------------
  { id: 'lookRateVsFrameRate', run: async (ctx) => {
    // REALTIME, deliberately, and last. ISSUE #37, and the one section in this
    // file that is not about the pad at all — the stick is only the one look
    // source a headless run can hold steady, since a mouse needs pointer lock
    // and touch needs a phone. Whatever it measures here is true of all three:
    // they meet in `Input.mouseDX`.
    //
    // Look delta is a QUANTITY the camera integrates, and
    // `ThirdPersonCamera.update` runs once per SIMULATION SLICE while a
    // rendered frame drains anywhere from none to MAX_STEPS of them. Read
    // rather than taken, it was therefore applied once per slice — sensitivity
    // multiplied by the slice count. Measured before the fix, degrees of yaw
    // per second at full deflection:
    //
    //   fps=120 174   fps=60 221   fps=40 263   fps=30 350   fps=20 511
    //
    // and after: 174.5 / 174.2 / 174.9 / 175.5 / 171.8. The player-facing
    // symptom is the hitch, not the low cap: one 200 ms frame in a fight spent
    // 200 ms of mouse movement FOUR times over.
    //
    // This CANNOT be fast-forwarded: `__dbgAdvance` polls the pad once per
    // slice by construction, so the slices-per-rendered-frame ratio the defect
    // lives in never exceeds 1 under simulated time. It needs real rendered
    // frames at real caps — private pages (the caps are boot flags; 20 is not a
    // `__dbgGfx fpsCap` choice) and real sleeps.
    //
    // 20 and 120 because they straddle SIM_HZ 60 by 3x — the widest ratio the
    // cap can buy — and the assertion is on the SPREAD between them, not on the
    // absolute figure, so it survives a host whose expo curve or frame pacing
    // puts the nominal somewhere slightly else.
    const accumulateYaw = async (page, ms) => {
      let prev = await probe(page, '__dbgCamYaw');
      let total = 0;
      for (let i = 0; i < Math.max(1, Math.round(ms / 200)); i++) {
        await sleep(200);                    // REALTIME — see above
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
    };

    const bctx = await ctx.page.browser().createBrowserContext();
    try {
      const rates = {};
      for (const fps of [20, 120]) {
        const page = await bootPadPage(bctx, 'Xbox Wireless Controller', { query: `menu=0&fs=0&fps=${fps}` });
        await setAxes(page, [0, 0, 1, 0]);
        await sleep(200);                    // REALTIME spin-up
        const t0 = Date.now();
        const yaw = await accumulateYaw(page, 2000);
        rates[fps] = (yaw * 180) / Math.PI / ((Date.now() - t0) / 1000);
        await setAxes(page, [0, 0, 0, 0]);
        await page.close();
      }
      const lo = Math.min(rates[20], rates[120]);
      const hi = Math.max(rates[20], rates[120]);
      ctx.res.lookRateVsFrameRate = {
        degPerSecAt20: +rates[20].toFixed(1),
        degPerSecAt120: +rates[120].toFixed(1),
        ratio: +(hi / lo).toFixed(3),
        // 1.15 is measurement noise (frame pacing, the 200 ms sampling grid);
        // the defect this guards against is a whole slice's worth, i.e. 2x or 3x.
        frameRateIndependent: hi / lo < 1.15,
      };
      ctx.check(ctx.res.lookRateVsFrameRate.frameRateIndependent,
        `the look rate depends on the frame cap: ${ctx.res.lookRateVsFrameRate.degPerSecAt20} deg/s `
        + `at fps=20 against ${ctx.res.lookRateVsFrameRate.degPerSecAt120} at fps=120 `
        + `(ratio ${ctx.res.lookRateVsFrameRate.ratio}) — issue #37 is back`);
    } finally {
      await bctx.close();
    }
  } },
];

if (import.meta.main) {
  const { soloRun } = await import('./suite/harness.mjs');
  await soloRun({ name, sections });
}
