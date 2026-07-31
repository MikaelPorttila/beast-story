// Verifies touch support: overlay exists ONLY on touch devices, the virtual
// stick moves the player, look-drag turns the camera, and buttons fire.
// Usage: bun tools/test-touch.mjs
import { launchBrowser, newPage, newContextPage, wait, count, isVisible } from './browser.mjs';

const browser = await launchBrowser();
const results = {};

// ---------- desktop: no overlay, no touch logic ----------
{
  const page = await newPage(browser, { width: 1280, height: 800 });
  await page.goto('http://localhost:5187/?fps=30&menu=0', { waitUntil: 'load' });
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
  await page.goto('http://localhost:5187/?fps=30&menu=0', { waitUntil: 'load' });
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

  results.phone = {
    overlayPresent: overlay > 0,
    stick, moveStick, lookStick, skills, buttons, hotbarHidden,
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

console.log(JSON.stringify(results, null, 2));
await browser.close();
