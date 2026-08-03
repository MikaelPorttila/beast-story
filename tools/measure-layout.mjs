// Measures canvas vs viewport vs crosshair geometry in portrait and landscape
// on an emulated touch device, so layout bugs are diagnosed by numbers rather
// than by eyeballing screenshots.
import { launchBrowser, newContextPage, wait } from './browser.mjs';
import { BASE as HOST } from './target.mjs';

const browser = await launchBrowser();
const out = {};

for (const [name, viewport] of [
  ['portrait', { width: 393, height: 851 }],
  ['landscape', { width: 851, height: 393 }],
]) {
  const { ctx, page } = await newContextPage(browser, { ...viewport, phone: true });
  await page.goto(`${HOST}/?fps=30&menu=0`, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await wait(4000);
  out[name] = await page.evaluate(() => {
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
    };
    const c = document.querySelector('canvas');
    const cr = c.getBoundingClientRect();
    const cross = document.querySelector('.bs-cross');
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
      stick: rect('.bs-stick'),
      lookPad: rect('.bs-look'),
      // .bs-skills / .bs-btns are ZERO-SIZED origin points parked on a stick's
      // centre — each button is placed off them by a polar transform — so their
      // own rect says nothing about where the controls are. The per-button list
      // below is what to read, and what the overflow check walks.
      skills: rect('.bs-skills'),
      btns: rect('.bs-btns'),
      buttons: [...document.querySelectorAll('.bs-btn,.bs-skill')].map((el) => {
        const r = el.getBoundingClientRect();
        return {
          label: el.textContent,
          x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1),
        };
      }),
      // How close the nearest control edge comes to the reticle. This is the
      // number the layout exists to protect: the centre of the frame is where
      // the player is aiming and it must stay clear.
      nearestControlToCross: (() => {
        if (!crossR) return null;
        const cx = crossR.x + crossR.width / 2, cy = crossR.y + crossR.height / 2;
        let best = Infinity, who = null;
        for (const el of document.querySelectorAll('.bs-btn,.bs-skill,.bs-stick')) {
          const r = el.getBoundingClientRect();
          const dx = Math.max(r.left - cx, 0, cx - r.right);
          const dy = Math.max(r.top - cy, 0, cy - r.bottom);
          const d = Math.hypot(dx, dy);
          if (d < best) { best = d; who = el.className + ':' + el.textContent; }
        }
        return { px: +best.toFixed(1), el: who };
      })(),
      party: rect('.bs-left'),
      overflowsRight: (() => {
        const bad = [];
        const off = (r, name) => {
          if (r && (r.x < -0.5 || r.y < -0.5
            || r.x + r.w > innerWidth + 0.5 || r.y + r.h > innerHeight + 0.5)) bad.push(name);
        };
        for (const sel of ['.bs-stick', '.bs-look', '.bs-left']) off(rect(sel), sel);
        for (const el of document.querySelectorAll('.bs-btn,.bs-skill')) {
          const r = el.getBoundingClientRect();
          off({ x: r.x, y: r.y, w: r.width, h: r.height }, `${el.className}:${el.textContent}`);
        }
        return bad;
      })(),
    };
  });
  await page.screenshot({ path: `shots/layout-${name}.png` });
  await ctx.close();
}

console.log(JSON.stringify(out, null, 2));
await browser.close();
