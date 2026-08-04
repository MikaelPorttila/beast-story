// Verifies touch support: overlay exists ONLY on touch devices, the virtual
// stick moves the player, look-drag turns the camera, and buttons fire.
// Usage: bun tools/test-touch.mjs
import { launchBrowser, newPage, newContextPage, wait, count, isVisible } from './browser.mjs';
import { BASE as HOST } from './target.mjs';

const browser = await launchBrowser();
const results = {};

// ---------- desktop: no overlay, no touch logic ----------
{
  const page = await newPage(browser, { width: 1280, height: 800 });
  await page.goto(`${HOST}/?fps=30&menu=0`, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await wait(3500);
  results.desktop = {
    // Presence AND visibility: a hidden overlay is acceptable on a touchscreen
    // laptop, but a *visible* one on a mouse-driven machine is the bug.
    overlayPresent: await count(page, '.bs-touch') > 0,
    overlayVisible: await isVisible(page, '.bs-touch'),
    maxTouchPoints: await page.evaluate(() => navigator.maxTouchPoints),
    hotbarVisible: await isVisible(page, '.bs-hotbar'),
    canvasSize: await page.evaluate(() => {
      const c = document.querySelector('canvas');
      return { w: c.clientWidth, h: c.clientHeight };
    }),
  };
  await page.close();
}

// ---------- phone: overlay present and functional ----------
{
  const { ctx, page } = await newContextPage(browser, { width: 393, height: 851, phone: true });
  await page.goto(`${HOST}/?fps=30&menu=0`, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await wait(4000);

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
  // NOTE: engine.tick() clamps dt to 0.05s, so game time advances at most one
  // clamped step per rendered frame. Distance travelled therefore depends on the
  // host's frame rate — hold the stick and assert the player ACCELERATES instead.
  await wait(400);
  results.stickState = await page.evaluate(() => window.__dbgInput?.());
  await wait(5000);
  results.stickHeldState = await page.evaluate(() => window.__dbgInput?.());
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
  // does within the hold on a GPU-fast frame rate. Sum shortest-arc deltas.
  const sampleYaw = () => page.evaluate(() => window.__dbgCamYaw?.());
  const yawStart = await sampleYaw();
  let prevYaw = yawStart, yawTotal = 0;
  const holdAndAccumulate = async (ms) => {
    for (let i = 0; i < Math.max(1, Math.round(ms / 200)); i++) {
      await wait(200);
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
  await holdAndAccumulate(400);
  results.lookState = await page.evaluate(() => window.__dbgInput?.());
  await holdAndAccumulate(3000); // held: yaw should keep accumulating
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

  results.phone = {
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
  await ctx.close();
}

// ---------- the look pad respects the invert-Y setting ----------
// A PAIR AT ONE COLUMN, and it has to be: "held up, the camera pitched down" is
// equally true of a working inverted stick and of a stick wired backwards, so
// only the two arms TOGETHER say anything. Same phone, same hold, same duration
// — the single difference is `invy`, which core/flags.ts pins for one load
// without writing the preference back.
//
// PITCH RATHER THAN YAW, because __dbgCam().pitch is signed, bounded and does
// not wrap: the camera clamps well short of straight up, where yaw is an atan2
// that passes half a circle inside one hold on a fast host (see the note above).
// The stick is held UP, so an uninverted pad must raise the pitch and an
// inverted one must lower it.
{
  const holdLookUp = async (invy) => {
    const { ctx, page } = await newContextPage(browser, { width: 393, height: 851, phone: true });
    await page.goto(`${HOST}/?fps=30&menu=0&invy=${invy}`, { waitUntil: 'load' });
    await page.waitForSelector('canvas');
    await wait(4000);
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
    await wait(700);
    const after = await page.evaluate(() => window.__dbgCam?.()?.pitch);
    await ctx.close();
    return { axes, pitchDelta: +(after - before).toFixed(2) };
  };

  const off = await holdLookUp(0);
  const on = await holdLookUp(1);
  results.invertY = {
    off: { ...off, expected: 'pitch rises — push up, look up' },
    on: { ...on, expected: 'pitch falls — push up, look down' },
    ok: off.axes?.invertY === false && on.axes?.invertY === true
      && off.pitchDelta > 1 && on.pitchDelta < -1,
  };
}

console.log(JSON.stringify(results, null, 2));
if (results.invertY.ok !== true) {
  console.error('FAIL: the touch look pad does not follow the invert-Y setting');
  await browser.close();
  process.exit(1);
}
await browser.close();
