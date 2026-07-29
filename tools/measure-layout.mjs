// Measures canvas vs viewport vs crosshair geometry in portrait and landscape
// on an emulated touch device, so layout bugs are diagnosed by numbers rather
// than by eyeballing screenshots.
import { chromium, devices } from 'playwright';

const args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'];
const browser = await chromium.launch({ args });
const out = {};

for (const [name, viewport] of [
  ['portrait', { width: 393, height: 851 }],
  ['landscape', { width: 851, height: 393 }],
]) {
  const ctx = await browser.newContext({
    ...devices['Pixel 5'], viewport, hasTouch: true, isMobile: true,
  });
  const page = await ctx.newPage();
  await page.goto('http://localhost:5187/?fps=30', { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await page.waitForTimeout(4000);
  out[name] = await page.evaluate(() => {
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
    };
    const c = document.querySelector('canvas');
    const cr = c.getBoundingClientRect();
    const cross = document.querySelector('.cp-cross');
    const crossR = cross?.getBoundingClientRect();
    return {
      window: { w: innerWidth, h: innerHeight },
      canvas: rect('canvas'),
      canvasBuffer: { w: c.width, h: c.height },
      canvasCentre: { x: +(cr.x + cr.width / 2).toFixed(1), y: +(cr.y + cr.height / 2).toFixed(1) },
      crossCentre: crossR
        ? { x: +(crossR.x + crossR.width / 2).toFixed(1), y: +(crossR.y + crossR.height / 2).toFixed(1) }
        : null,
      crossOffsetFromCanvasCentre: crossR
        ? { dx: +((crossR.x + crossR.width / 2) - (cr.x + cr.width / 2)).toFixed(1),
            dy: +((crossR.y + crossR.height / 2) - (cr.y + cr.height / 2)).toFixed(1) }
        : null,
      stick: rect('.cp-stick'),
      lookPad: rect('.cp-look'),
      skills: rect('.cp-skills'),
      btns: rect('.cp-btns'),
      party: rect('.cp-left'),
      overflowsRight: (() => {
        const bad = [];
        for (const sel of ['.cp-stick', '.cp-skills', '.cp-btns', '.cp-left']) {
          const r = rect(sel);
          if (r && (r.x < 0 || r.y < 0 || r.x + r.w > innerWidth + 0.5 || r.y + r.h > innerHeight + 0.5)) {
            bad.push(sel);
          }
        }
        return bad;
      })(),
    };
  });
  await page.screenshot({ path: `shots/layout-${name}.png`, timeout: 120000 });
  await ctx.close();
}

console.log(JSON.stringify(out, null, 2));
await browser.close();
