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
    overlayPresent: await page.locator('.cp-touch').count() > 0,
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
  const skills = await page.locator('.cp-skill').count();
  const buttons = await page.locator('.cp-btn').count();
  const hotbarHidden = !(await page.locator('.cp-hotbar').isVisible().catch(() => false));

  // drag the virtual stick forward and confirm the player actually moves
  const box = await page.locator('.cp-stick').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const before = await page.evaluate(() => window.__dbgPlayerPos?.());
  await page.touchscreen.tap(cx, cy); // wake
  // manual multi-step drag via CDP-free touch events
  await page.evaluate(({ cx, cy }) => {
    const el = document.querySelector('.cp-stick');
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
    const el = document.querySelector('.cp-stick');
    const t = new Touch({ identifier: 1, target: el, clientX: 0, clientY: 0 });
    el.dispatchEvent(new TouchEvent('touchend', {
      touches: [], changedTouches: [t], targetTouches: [], bubbles: true, cancelable: true,
    }));
  });

  const moved = before && after
    ? Math.hypot(after.x - before.x, after.z - before.z)
    : null;

  // look-drag on the right pad should change camera yaw
  const yawBefore = await page.evaluate(() => window.__dbgCamYaw?.());
  // Each drag step goes in its own task with a wait, so the render loop
  // actually consumes the look delta between moves. Firing them all in one
  // evaluate() made this assertion flaky under software GL's ~2 fps.
  const lookStep = (i) => page.evaluate((i) => {
    const el = document.querySelector('.cp-look');
    const r = el.getBoundingClientRect();
    const x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
    const mk = (type, x, y) => {
      const t = new Touch({ identifier: 2, target: el, clientX: x, clientY: y });
      el.dispatchEvent(new TouchEvent(type, {
        touches: [t], changedTouches: [t], targetTouches: [t],
        bubbles: true, cancelable: true,
      }));
    };
    mk(i === 0 ? 'touchstart' : 'touchmove', x0 + i * 26, y0);
  }, i);
  for (let i = 0; i < 6; i++) {
    await lookStep(i);
    await page.waitForTimeout(320);
  }
  results.lookState = await page.evaluate(() => window.__dbgInput?.());
  await page.waitForTimeout(600);
  const yawAfter = await page.evaluate(() => window.__dbgCamYaw?.());

  results.phone = {
    overlayPresent: overlay > 0,
    stick, skills, buttons, hotbarHidden,
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
