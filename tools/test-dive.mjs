// Verifies diving (src/player/index.ts) and the underwater view
// (src/world/underwater.ts, and the exposure it drives through core/engine.ts).
//
// Usage: bun tools/test-dive.mjs        (dev server must be up)
//
// This is the guard for issue #23, which was two things wearing one hat: you
// could not get under the water, and if the camera got under on its own the
// frame turned white. They have to be tested together, because the second is
// only reachable through the first — every earlier probe in tools/ drives a hero
// who is standing on the ground or floating on the surface, which is why a lake
// bed that photographed as a white room went unnoticed.
//
// The picture half MEASURES PIXELS rather than asserting on uniforms, and it has
// to. Every number the effect is built from — amount, fog, the tint colour —
// read perfectly correct while the frame was white, because the thing that broke
// it was the tone curve downstream of all of them. So the assertion is on the
// image: a submerged frame must be BLUER and DARKER than the same view in the
// air, and must not be a neutral white-out.
//
// A WebGL canvas without preserveDrawingBuffer reads back empty through
// drawImage, so the screenshot is taken by the browser and handed back INTO the
// page to be decoded. Reading the canvas directly reports 0,0,0 — including
// above water, which is how that was caught.
//
// Exits non-zero.
import { launchBrowser, leaveSplash, newPage, wait } from './browser.mjs';
import { BASE as HOST } from './target.mjs';

const browser = await launchBrowser();
const page = await newPage(browser, { width: 1280, height: 800 });
page.on('pageerror', (e) => console.error('[page]', e.message));

// Through the MENU, not `menu=0`: mouse look needs the pointer lock that
// beginPlay takes, and pitching the camera under the surface is how the view
// half of this test is reached.
await page.goto(`${HOST}/?fs=0`, { waitUntil: 'load' });
// `leaveSplash`, not a single `press('Enter')`: the press that dismisses the
// splash is dropped if it lands before the menu's key handler is live, and
// nothing retried it. That is the whole of this probe's batch flake — it passed
// alone and failed after two predecessors, on a clean browser. See
// tools/browser.mjs.
await leaveSplash(page);
await (await page.waitForSelector('button[data-act="new"]', { visible: true })).click();
for (let i = 0; i < 45; i++) {
  await wait(1000);
  if (await page.evaluate(() =>
    !!window.__dbgPlayerPos && !document.querySelector('.bs-load.cover.show'))) break;
}
await wait(1500);

const results = {};
const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); };
const round = (v, n = 2) => +v.toFixed(n);

const pos = () => page.evaluate(() => window.__dbgPlayerPos());
const under = () => page.evaluate(() => window.__dbgUnder());
const comp = () => page.evaluate(() => window.__dbgCompanions());

/** Mean colour of the middle of the frame. See the note at the top. */
async function frame() {
  const b64 = await page.screenshot({ encoding: 'base64' });
  return page.evaluate(async (data) => {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res; img.onerror = rej; img.src = `data:image/png;base64,${data}`;
    });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    // Centre band only: the HUD lives at the edges and would drag the mean.
    const x0 = Math.floor(img.width * 0.28); const x1 = Math.floor(img.width * 0.72);
    const y0 = Math.floor(img.height * 0.15); const y1 = Math.floor(img.height * 0.68);
    const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let r = 0; let g = 0; let b = 0; let n = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
    r /= n; g /= n; b /= n;
    const mx = Math.max(r, g, b); const mn = Math.min(r, g, b);
    return {
      r: Math.round(r), g: Math.round(g), b: Math.round(b),
      luma: Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b),
      sat: +((mx - mn) / Math.max(mx, 1)).toFixed(3),
      /** Is blue actually the strongest channel? A white-out fails this. */
      blueLeads: b > r + 20,
    };
  }, b64);
}

// The deepest SWIMMABLE water within reach of the spawn, found rather than
// pinned, so no coordinate here depends on the seed staying put.
//
// `!w.deep` was added with the deep sea (issue #76) and it is not a workaround:
// past DEEP_WATER_DEPTH a swimmer is refused entry and carried back to the
// shallows on purpose (see Player.undertow), so the deepest column in the world
// is now precisely the one place this test could not run. What it measures —
// that holding C takes the hero down, that the bed catches him, and that the
// submerged frame is blue rather than white — is a fact about water you can
// swim in, and this picks the deepest of that.
const deep = await page.evaluate(() => {
  const s = window.__dbgTowns().spawn;
  let best = null;
  for (let dx = -120; dx <= 120; dx += 2) {
    for (let dz = -120; dz <= 120; dz += 2) {
      const x = s.x + dx; const z = s.z + dz;
      const w = window.__dbgWorld(x, z);
      if (w.deep) continue;
      if (!best || w.ground < best.ground) best = { x, z, ground: w.ground };
    }
  }
  return best;
});
await page.evaluate((d) => window.__dbgTp(d.x, d.z), deep);
await wait(2500);

// ---------- floating: he sits on the surface and the frame is daylight -------
{
  const p = await pos();
  const u = await under();
  const f = await frame();
  results.floating = {
    y: round(p.y), bed: round(deep.ground), amount: u.amount,
    exposureLike: u.fogAbsorb, frame: f,
  };
  check(u.amount === 0, `the lens is already wet before diving (amount ${u.amount})`);
  check(!f.blueLeads || f.sat < 0.75, 'the surface frame is already a blue wash');
  results.floating.surfaceY = round(p.y + 1.15);
}

// ---------- hold C: he goes DOWN, and stops at the bed ----------------------
// KeyC stays HELD from here until the surfacing section. The camera has to be
// pitched under for the picture test, which takes a few seconds of mouse moves,
// and a hero who floated back up during them would be photographed at the
// surface and measured surfacing from nowhere.
{
  const before = (await pos()).y;
  await page.keyboard.down('KeyC');
  const track = [];
  for (let i = 0; i < 10; i++) {
    await wait(400);
    track.push(round((await pos()).y));
  }
  const after = (await pos()).y;
  results.diving = {
    from: round(before), to: round(after), descended: round(before - after),
    bed: round(deep.ground), track,
    /** Negative means he went through the lake bed. */
    aboveBed: round(after - deep.ground),
  };
  check(before - after > 1.5,
    `holding C did not take him down (${round(before - after)} units)`);
  check(after >= deep.ground - 0.05,
    `he dived THROUGH the bed: ${round(after)} against a bed at ${round(deep.ground)}`);
}

// ---------- down there, the frame is blue, not white ------------------------
{
  // Pitch the camera under with him so the view being tested is the view a
  // diving player has.
  for (let i = 0; i < 12; i++) {
    await page.mouse.move(0, 0);
    await page.mouse.move(0, 120, { steps: 6 });
    await wait(250);
    if ((await under()).amount > 0.9) break;
  }
  await wait(700);
  const u = await under();
  const f = await frame();
  const companions = await comp();
  const flyer = companions.beasts.find((b) => b.id === 'galebird');
  results.submerged = {
    depth: u.depth, amount: u.amount, fogAbsorb: u.fogAbsorb, frame: f, flyer,
  };

  check(u.amount > 0.9, `the lens never got under (amount ${u.amount})`);
  // The three ways the old frame failed, as three separate numbers. Brightness
  // is measured against the WHITE-OUT rather than against the surface frame:
  // the two are shot at different camera pitches (level, then tipped under), so
  // one being darker than the other says as much about the framing as about the
  // water. 200 is comfortably under the 221 the bug photographed at and
  // comfortably over anything the effect produces working.
  check(f.blueLeads,
    `the submerged frame is not blue-dominant: rgb(${f.r}, ${f.g}, ${f.b})`);
  check(f.sat > 0.30,
    `the submerged frame is washed out: saturation ${f.sat} (white-out was 0.131)`);
  check(f.luma < 200,
    `the submerged frame is blown out: luma ${f.luma} (white-out was 221)`);
  check(u.fogAbsorb[0] < 0.5 && u.fogAbsorb[2] > u.fogAbsorb[0],
    `the distance is not being absorbed toward water: ${JSON.stringify(u.fogAbsorb)}`);
  check(!!flyer?.transit, 'Galebird did not convert to light for the deep dive');
  check(!flyer?.drawn, 'Galebird body is still drawn underwater');
}

// ---------- release: he surfaces, and does not rocket -----------------------
{
  await page.keyboard.up('KeyC');   // held since the dive section, see there
  const from = (await pos()).y;
  const t0 = Date.now();
  let peak = 0;
  let last = from;
  for (let i = 0; i < 24; i++) {
    await wait(250);
    const y = (await pos()).y;
    const v = (y - last) / 0.25;
    if (v > peak) peak = v;
    last = y;
    if (y > results.floating.surfaceY - 1.4) break;
  }
  results.surfacing = {
    from: round(from), to: round(last), seconds: round((Date.now() - t0) / 1000),
    peakRiseSpeed: round(peak),
    backAtFloat: last > results.floating.surfaceY - 1.5,
  };
  check(results.surfacing.backAtFloat,
    `he did not come back up (rested at ${round(last)})`);
  // The cork. Uncapped buoyancy from the bed peaked around 10 units/s.
  check(peak < 6,
    `he rocketed to the surface at ${round(peak)} units/s — buoyancy is uncapped`);
}

// ---------- and the view goes back to daylight ------------------------------
// The camera has to come back UP too. It was tipped under for the picture test
// and a third-person camera below the waterline is legitimately still wet even
// with the hero floating — that is the whole reason this effect keys off the
// LENS and not the swimmer.
{
  // A MONOTONIC sweep, not the reset-and-drag pair used on the way down. Under
  // pointer lock what the page sees is the DELTA, so "jump back to the top, drag
  // down again" nets zero per iteration and the pitch only moved on the way down
  // because it was already against its clamp. Walking y steadily from the bottom
  // of the viewport to the top is an unambiguous run of negative deltas.
  for (let i = 14; i >= 0; i--) {
    await page.mouse.move(0, i * 55, { steps: 4 });
    await wait(200);
    if ((await under()).amount < 0.05) break;
  }
  await wait(1200);
  const u = await under();
  const companions = await comp();
  const flyer = companions.beasts.find((b) => b.id === 'galebird');
  results.afterSurfacing = { amount: u.amount, fogAbsorb: u.fogAbsorb, flyer };
  check(u.amount < 0.2, `still tinted at the surface (amount ${u.amount})`);
  check(u.fogAbsorb.every((c) => c > 0.85),
    `the fog absorption was not put back: ${JSON.stringify(u.fogAbsorb)}`);
  check(!flyer?.transit && !!flyer?.drawn,
    'Galebird did not return to a visible body after surfacing');
}

console.log(JSON.stringify({ ...results, failures: fails, pass: fails.length === 0 }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
