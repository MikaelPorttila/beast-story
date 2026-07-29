// Verifies the crosshair is (a) pixel-centred and (b) actually white, by
// rendering the HUD over a flat dark backdrop and finding the centroid of the
// bright pixels. DOM geometry can claim centred while the painted result drifts,
// so this measures pixels.
import { chromium, devices } from 'playwright';
import { PNG } from 'pngjs';
import fs from 'node:fs';

const args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'];
const browser = await chromium.launch({ args });
const out = {};

for (const [name, viewport, ctxOpts] of [
  ['desktop', { width: 1200, height: 800 }, {}],
  ['phone-portrait', { width: 393, height: 851 }, { ...devices['Pixel 5'], hasTouch: true, isMobile: true }],
  ['phone-landscape', { width: 851, height: 393 }, { ...devices['Pixel 5'], hasTouch: true, isMobile: true }],
]) {
  const ctx = await browser.newContext({ ...ctxOpts, viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto('http://localhost:5187/?fps=30', { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await page.waitForTimeout(3500);
  // Hide the 3D canvas and everything except the reticle, then paint the page
  // black so the only bright pixels ARE the crosshair.
  await page.addStyleTag({ content: `
    canvas{display:none!important}
    html,body{background:#000!important}
    .cp-root>*:not(.cp-cross){display:none!important}
    .cp-touch,.cp-left,.cp-title,.cp-shards,.cp-toasts{display:none!important}
  ` });
  await page.waitForTimeout(400);
  const file = `shots/_cross-${name}.png`;
  await page.screenshot({ path: file, timeout: 120000 });
  await ctx.close();

  const png = PNG.sync.read(fs.readFileSync(file));
  let sx = 0, sy = 0, n = 0, minR = 255, minG = 255, minB = 255;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (png.width * y + x) << 2;
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      if (r > 170 && g > 170 && b > 170) {
        sx += x; sy += y; n++;
        if (r < minR) minR = r;
        if (g < minG) minG = g;
        if (b < minB) minB = b;
      }
    }
  }
  // Work in CSS coordinate space: pixel index i covers [i, i+1), so its centre
  // is i+0.5, and the viewport centre is width/2. (Comparing a centroid of
  // indices against width/2 - 0.5 reports a phantom half-pixel offset.)
  const cx = png.width / 2;
  const cy = png.height / 2;
  const centroidX = sx / n + 0.5;
  const centroidY = sy / n + 0.5;
  out[name] = n === 0 ? { error: 'no bright pixels found' } : {
    brightPixels: n,
    centroid: { x: +centroidX.toFixed(2), y: +centroidY.toFixed(2) },
    imageCentre: { x: cx, y: cy },
    offset: { dx: +(centroidX - cx).toFixed(2), dy: +(centroidY - cy).toFixed(2) },
    // white means the channels stay together; a tint shows as a channel gap
    dimmestBrightPixel: { r: minR, g: minG, b: minB },
    isNeutralWhite: Math.max(minR, minG, minB) - Math.min(minR, minG, minB) <= 6,
  };
  fs.unlinkSync(file);
}

console.log(JSON.stringify(out, null, 2));
await browser.close();
