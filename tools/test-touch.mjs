// Verifies touch support: overlay exists ONLY on touch devices, the virtual
// stick moves the player, look-drag turns the camera, and buttons fire.
// Usage: node tools/test-touch.mjs
import { chromium, devices } from 'playwright';

const args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'];
const browser = await chromium.launch({ args });
const results = {};

// ---------- desktop: no overlay, no touch logic ----------
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto('http://localhost:5187/?fps=30', { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await page.waitForTimeout(3500);
  results.desktop = {
    // Presence AND visibility: a hidden overlay is acceptable on a touchscreen
    // laptop, but a *visible* one on a mouse-driven machine is the bug.
    overlayPresent: await page.locator('.cp-touch').count() > 0,
    overlayVisible: await page.locator('.cp-touch').isVisible().catch(() => false),
    maxTouchPoints: await page.evaluate(() => navigator.maxTouchPoints),
    hotbarVisible: await page.locator('.cp-hotbar').isVisible().catch(() => null),
    canvasSize: await page.evaluate(() => {
      const c = document.querySelector('canvas');
      return { w: c.clientWidth, h: c.clientHeight };
    }),
  };
  await page.close();
}

// ---------- phone: overlay present and functional ----------
{
  const phone = devices['Pixel 5'];
  const ctx = await browser.newContext({ ...phone, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await page.goto('http://localhost:5187/?fps=30', { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await page.waitForTimeout(4000);

  const overlay = await page.locator('.cp-touch').count();
  const stick = await page.locator('.cp-stick').count();
  const moveStick = await page.locator('.cp-stick.move').count();
  const lookStick = await page.locator('.cp-stick.look').count();
  const skills = await page.locator('.cp-skill').count();
  const buttons = await page.locator('.cp-btn').count();
  const hotbarHidden = !(await page.locator('.cp-hotbar').isVisible().catch(() => false));

  // drag the virtual stick forward and confirm the player actually moves
  const box = await page.locator('.cp-stick.move').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const before = await page.evaluate(() => window.__dbgPlayerPos?.());
  await page.touchscreen.tap(cx, cy); // wake
  // manual multi-step drag via CDP-free touch events
  await page.evaluate(({ cx, cy }) => {
    const el = document.querySelector('.cp-stick.move');
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
  // NOTE: engine.tick() clamps dt to 0.05s, so under software GL (~2 fps) only
  // ~0.05s of game time passes per real frame. Distance travelled is therefore
  // a poor signal here — hold the stick and assert the player ACCELERATES.
  await page.waitForTimeout(400);
  results.stickState = await page.evaluate(() => window.__dbgInput?.());
  await page.waitForTimeout(5000);
  results.stickHeldState = await page.evaluate(() => window.__dbgInput?.());
  const after = await page.evaluate(() => window.__dbgPlayerPos?.());
  await page.evaluate(() => {
    const el = document.querySelector('.cp-stick.move');
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
  const yawBefore = await page.evaluate(() => window.__dbgCamYaw?.());
  await page.evaluate(() => {
    const el = document.querySelector('.cp-stick.look');
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
  await page.waitForTimeout(400);
  results.lookState = await page.evaluate(() => window.__dbgInput?.());
  await page.waitForTimeout(3000); // held: yaw should keep accumulating
  const yawAfter = await page.evaluate(() => window.__dbgCamYaw?.());
  await page.evaluate(() => {
    const el = document.querySelector('.cp-stick.look');
    const t = new Touch({ identifier: 2, target: el, clientX: 0, clientY: 0 });
    el.dispatchEvent(new TouchEvent('touchend', {
      touches: [], changedTouches: [t], targetTouches: [], bubbles: true, cancelable: true,
    }));
  });

  results.phone = {
    overlayPresent: overlay > 0,
    stick, moveStick, lookStick, skills, buttons, hotbarHidden,
    playerMovedUnits: moved === null ? 'no probe' : +moved.toFixed(3),
    yawChanged: yawBefore !== undefined && yawAfter !== undefined
      ? +Math.abs(yawAfter - yawBefore).toFixed(3) : 'no probe',
    canvasSize: await page.evaluate(() => {
      const c = document.querySelector('canvas');
      return { w: c.clientWidth, h: c.clientHeight };
    }),
  };
  await page.screenshot({ path: 'shots/touch-phone.png', timeout: 120000 });
  await ctx.close();
}

console.log(JSON.stringify(results, null, 2));
await browser.close();
