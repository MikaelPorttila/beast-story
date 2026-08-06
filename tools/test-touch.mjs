// Verifies touch support: overlay exists ONLY on touch devices, the virtual
// stick moves the player, look-drag turns the camera, and buttons fire.
//
// Usage: bun tools/test-touch.mjs        (dev server must be up)
//        ...or as sections inside `bun tools/suite.mjs` — same code either way.
//
// FAST-FORWARDED, SHARED-SESSION, with a twist: the touch overlay only exists
// on a touch DEVICE, so the phone and invert-Y sections run on PRIVATE pages
// booted with the Pixel 5 emulation (`phone: true` in tools/browser.mjs) and
// fast-forward those with `advance(page, s)` — the stick and look-pad inputs
// are consumed in simulate(), so held touches advance exactly like held keys.
// The desktop half reads the suite's shared page, which IS the mouse-driven
// machine the assertion is about. Declared sleeps before the conversion:
// 17.8 s (25.7 s counting the invert-Y arms' per-boot settles), plus three
// full real-time boots.
import { newPage } from './browser.mjs';
import { BASE as HOST } from './target.mjs';
import { advance } from './suite/harness.mjs';

/** Boot a private PHONE page (Pixel 5 emulation) and wait on the boot's own
 * "done" state rather than a clock. Caller owns the context and must close it. */
async function bootPhonePage(bctx, query = 'menu=0') {
  const page = await newPage(bctx, { width: 393, height: 851, phone: true });
  await page.goto(`${HOST}/?${query}`, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await page.waitForFunction(
    () => window.__dbgBoot && window.__dbgBoot().playing && window.__dbgAdvance,
    { timeout: 60000 },
  );
  // One advanced beat so the overlay and input plumbing have ticked once.
  await advance(page, 0.5);
  return page;
}

const count = async (page, sel) => (await page.$$(sel)).length;
const isVisible = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return false;
  const st = getComputedStyle(el);
  if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}, sel);

export const name = 'touch';
export const sections = [

  // -------------------------------------------------------------------------
  { id: 'desktop', run: async (ctx) => {
    // No overlay, no touch logic, on a mouse-driven machine — which is what
    // the SHARED page is (1280x800, no touch emulation), so this section reads
    // it in place instead of booting one to look at.
    ctx.res.desktop = {
      // Presence AND visibility: a hidden overlay is acceptable on a touchscreen
      // laptop, but a *visible* one on a mouse-driven machine is the bug.
      overlayPresent: await count(ctx.page, '.bs-touch') > 0,
      overlayVisible: await isVisible(ctx.page, '.bs-touch'),
      maxTouchPoints: await ctx.ev(() => navigator.maxTouchPoints),
      hotbarVisible: await isVisible(ctx.page, '.bs-hotbar'),
      canvasSize: await ctx.ev(() => {
        const c = document.querySelector('canvas');
        return { w: c.clientWidth, h: c.clientHeight };
      }),
    };
  } },

  // -------------------------------------------------------------------------
  { id: 'phone', run: async (ctx) => {
    // Overlay present and functional. A PRIVATE page, necessarily: the overlay
    // is built off touch detection at boot, and the shared desktop page can
    // never grow one. A fresh context also keeps its saved progress out of the
    // shared profile.
    const bctx = await ctx.page.browser().createBrowserContext();
    try {
      const page = await bootPhonePage(bctx);

      const overlay = await count(page, '.bs-touch');
      const stick = await count(page, '.bs-stick');
      const moveStick = await count(page, '.bs-stick.move');
      const lookStick = await count(page, '.bs-stick.look');
      const skills = await count(page, '.bs-skill');
      const buttons = await count(page, '.bs-btn');
      const hotbarHidden = !(await isVisible(page, '.bs-hotbar'));

      // drag the virtual stick forward and confirm the player actually moves
      const box = await (await page.$('.bs-stick.move')).boundingBox();
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const before = await page.evaluate(() => window.__dbgPlayerPos?.());
      await page.touchscreen.tap(cx, cy); // wake
      // manual multi-step drag via CDP-free touch events
      await page.evaluate(({ cx, cy }) => {
        const el = document.querySelector('.bs-stick.move');
        const mk = (type, x, y) => {
          const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
          el.dispatchEvent(new TouchEvent(type, {
            touches: type === 'touchend' ? [] : [t],
            changedTouches: [t], targetTouches: type === 'touchend' ? [] : [t],
            bubbles: true, cancelable: true,
          }));
        };
        mk('touchstart', cx, cy);
        for (let i = 1; i <= 8; i++) mk('touchmove', cx, cy - i * 8);
      }, { cx, cy });
      // A held touch is sim-side state, so the whole hold advances: what was
      // wait(400) + wait(5000) of wall clock is 5.4 simulated seconds now.
      // (The old real-time note about engine.tick() clamping dt to 0.05s and
      // distance depending on the host frame rate no longer applies — advanced
      // slices are fixed-size — but the reading stays a reading, as before.)
      await advance(page, 0.4);
      ctx.res.stickState = await page.evaluate(() => window.__dbgInput?.());
      await advance(page, 5);
      ctx.res.stickHeldState = await page.evaluate(() => window.__dbgInput?.());
      const after = await page.evaluate(() => window.__dbgPlayerPos?.());
      await page.evaluate(() => {
        const el = document.querySelector('.bs-stick.move');
        const t = new Touch({ identifier: 1, target: el, clientX: 0, clientY: 0 });
        el.dispatchEvent(new TouchEvent('touchend', {
          touches: [], changedTouches: [t], targetTouches: [], bubbles: true, cancelable: true,
        }));
      });

      const moved = before && after
        ? Math.hypot(after.x - before.x, after.z - before.z)
        : null;

      // look-drag on the right pad should change camera yaw
      // The RIGHT stick is a rate control: hold it deflected and the camera keeps
      // turning. So push it once and simply hold, rather than dragging repeatedly.
      // __dbgCamYaw() is an atan2, so it wraps to ±π: a single before/after diff
      // understates the turn as soon as the camera passes half a circle, which it
      // does within the hold. Sum shortest-arc deltas, sampled every 0.2
      // SIMULATED seconds — the yaw integrates in simulate(), so the samples
      // land between advanced slices exactly as they landed between sleeps.
      const sampleYaw = () => page.evaluate(() => window.__dbgCamYaw?.());
      const yawStart = await sampleYaw();
      let prevYaw = yawStart, yawTotal = 0;
      const holdAndAccumulate = async (s) => {
        for (let i = 0; i < Math.max(1, Math.round(s / 0.2)); i++) {
          await advance(page, 0.2);
          const y = await sampleYaw();
          if (prevYaw !== undefined && y !== undefined) {
            let d = y - prevYaw;
            while (d > Math.PI) d -= 2 * Math.PI;
            while (d < -Math.PI) d += 2 * Math.PI;
            yawTotal += Math.abs(d);
          }
          prevYaw = y;
        }
      };
      await page.evaluate(() => {
        const el = document.querySelector('.bs-stick.look');
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const mk = (type, x, y) => {
          const t = new Touch({ identifier: 2, target: el, clientX: x, clientY: y });
          el.dispatchEvent(new TouchEvent(type, {
            touches: [t], changedTouches: [t], targetTouches: [t],
            bubbles: true, cancelable: true,
          }));
        };
        mk('touchstart', cx, cy);
        mk('touchmove', cx + r.width * 0.4, cy); // hold right = pan right
      });
      await holdAndAccumulate(0.4);
      ctx.res.lookState = await page.evaluate(() => window.__dbgInput?.());
      await holdAndAccumulate(3); // held: yaw should keep accumulating
      await page.evaluate(() => {
        const el = document.querySelector('.bs-stick.look');
        const t = new Touch({ identifier: 2, target: el, clientX: 0, clientY: 0 });
        el.dispatchEvent(new TouchEvent('touchend', {
          touches: [], changedTouches: [t], targetTouches: [], bubbles: true, cancelable: true,
        }));
      });

      // A FINGER IS A DEVICE YOU HOLD, so the rumble gate has to say so — the phone
      // buzzes through `navigator.vibrate`, and gating that on "is a controller the
      // live input" would have silenced every touch player. Read after the stick
      // drags above rather than after a tap on the scenery, because that is the
      // case that nearly broke: every stick and button in the overlay stops
      // touchstart from propagating, so the source stamp has to be a CAPTURE-phase
      // listener (see core/touch.ts). A phone player who only ever touches the
      // controls must still count as hands-on.
      const src = await page.evaluate(() => {
        const i = window.__dbgInput?.();
        return { lastSource: i?.lastSource, tactile: i?.tactile, feedback: window.__dbgFeedback?.()?.tactileInput };
      });

      ctx.res.phone = {
        overlayPresent: overlay > 0,
        stick, moveStick, lookStick, skills, buttons, hotbarHidden,
        lastSource: src.lastSource,
        tactile: src.tactile,
        feedbackTactile: src.feedback,
        playerMovedUnits: moved === null ? 'no probe' : +moved.toFixed(3),
        yawTurnedRadians: yawStart === undefined ? 'no probe' : +yawTotal.toFixed(3),
        canvasSize: await page.evaluate(() => {
          const c = document.querySelector('canvas');
          return { w: c.clientWidth, h: c.clientHeight };
        }),
      };
      await page.screenshot({ path: 'shots/touch-phone.png' });
    } finally {
      await bctx.close();
    }
  } },

  // -------------------------------------------------------------------------
  { id: 'invertY', run: async (ctx) => {
    // The look pad respects the invert-Y setting.
    //
    // A PAIR AT ONE COLUMN, and it has to be: "held up, the camera pitched down" is
    // equally true of a working inverted stick and of a stick wired backwards, so
    // only the two arms TOGETHER say anything. Same phone, same hold, same duration
    // — the single difference is `invy`, which core/flags.ts pins for one load
    // without writing the preference back. Each arm is a fresh boot by design
    // (the flag is read once, at load), so each owns a private page.
    //
    // PITCH RATHER THAN YAW, because __dbgCam().pitch is signed, bounded and does
    // not wrap: the camera clamps well short of straight up, where yaw is an atan2
    // that passes half a circle inside one hold on a fast host (see the note above).
    // The stick is held UP, so an uninverted pad must raise the pitch and an
    // inverted one must lower it.
    const holdLookUp = async (invy) => {
      const bctx = await ctx.page.browser().createBrowserContext();
      try {
        const page = await bootPhonePage(bctx, `menu=0&invy=${invy}`);
        const axes = await page.evaluate(() => window.__dbgInput?.()?.touchLookAxes);
        const before = await page.evaluate(() => window.__dbgCam?.()?.pitch);
        await page.evaluate(() => {
          const el = document.querySelector('.bs-stick.look');
          const r = el.getBoundingClientRect();
          const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          const mk = (type, x, y) => {
            const t = new Touch({ identifier: 3, target: el, clientX: x, clientY: y });
            el.dispatchEvent(new TouchEvent(type, {
              touches: [t], changedTouches: [t], targetTouches: [t],
              bubbles: true, cancelable: true,
            }));
          };
          mk('touchstart', cx, cy);
          mk('touchmove', cx, cy - r.height * 0.4); // hold UP
        });
        // Short: the pitch clamps, and a hold long enough to reach the clamp in both
        // arms would report the same magnitude whatever the sign did on the way.
        await advance(page, 0.7);
        const after = await page.evaluate(() => window.__dbgCam?.()?.pitch);
        return { axes, pitchDelta: +(after - before).toFixed(2) };
      } finally {
        await bctx.close();
      }
    };

    const off = await holdLookUp(0);
    const on = await holdLookUp(1);
    ctx.res.invertY = {
      off: { ...off, expected: 'pitch rises — push up, look up' },
      on: { ...on, expected: 'pitch falls — push up, look down' },
      ok: off.axes?.invertY === false && on.axes?.invertY === true
        && off.pitchDelta > 1 && on.pitchDelta < -1,
    };
    ctx.check(ctx.res.invertY.ok === true,
      'FAIL: the touch look pad does not follow the invert-Y setting');
  } },
];

if (import.meta.main) {
  const { soloRun } = await import('./suite/harness.mjs');
  await soloRun({ name, sections });
}
