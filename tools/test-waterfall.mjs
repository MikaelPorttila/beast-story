// Guards the reusable waterfall VFX (src/world/waterfall.ts) and the surgery
// that put it on the sky island in place of forty courses of voxel cubes
// (src/world/sky-island.ts).
//
// Usage: bun tools/test-waterfall.mjs        (dev server must be up)
//
// TWO STAGES, AND THE SPLIT IS FORCED. `cam=` and `look=` are only read under
// `photo=1` (see the framing branch in src/main.ts), and `photo=1` is exactly
// what pins the effect's clock so captures reproduce. So one page can either
// FRAME the fall or MEASURE ITS MOTION, never both:
//
//   * the LAB (lab.html?waterfall=1) has a fixed camera, no photo gate and a
//     bare backdrop, so it is where motion and the two ticket parameters are
//     measured;
//   * the GAME under `photo=1` is where the island's own regression lives — the
//     fall is really there, and removing the voxels really did not move the
//     rock.
//
// A WebGL canvas without preserveDrawingBuffer reads back empty, so every
// picture is taken by the browser and handed back INTO the page to be decoded.
// See the same note in tools/test-dive.mjs.
//
// KNOWN GAP, stated rather than papered over: nothing here drives a ZONE
// HANDOVER, so `Waterfall.dispose` is covered by construction (the island's own
// `dispose` calls it, and the module owns every geometry, material and texture
// it makes) and not by a measurement. Testing it needs a full walk through the
// gateway, which is tools/test-carrier.mjs's kind of job rather than this one's.
//
// Exits non-zero.
import { launchBrowser, newPage, wait } from './browser.mjs';
import { BASE as HOST } from './target.mjs';

const browser = await launchBrowser();
const page = await newPage(browser, { width: 1000, height: 900 });
page.on('pageerror', (e) => console.error('[page]', e.message));

const results = {};
const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); };

/**
 * Decode the frame in the page and hand back a small summary of one rectangle,
 * given in FRACTIONS of the frame so it survives a viewport change.
 *
 * `lowest` is the bottom-most row in the box holding a pixel that is not the
 * backdrop, as a fraction of the frame's height, or -1 when the box is empty.
 * `cx` is the horizontal centroid of those same pixels. Those two are what turn
 * "the fall is longer" and "the fall leans" into numbers.
 *
 * THE BACKDROP REFERENCE IS READ FROM JUST OUTSIDE THE BOX, one column each
 * side, per row, and interpolated across.
 *
 * The sky has a vertical gradient AND a horizontal one — it is a dome with a
 * sun in it, so the falloff is radial and only locally linear. Sampling one
 * pixel for a whole box makes everything far from it read as subject (a first
 * pass had the fall reaching the bottom of the frame in an arm where it ended
 * half way up); sampling the FRAME's two edges models the ramp linearly across
 * the whole width, which is still wrong by more than the threshold over a box
 * as tall as this one's. Ten pixels outside the box the gradient really is
 * linear, and that is all the model has to hold for.
 */
async function box(x0, y0, x1, y1) {
  const b64 = await page.screenshot({ encoding: 'base64' });
  return page.evaluate(async (data, f) => {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res; img.onerror = rej; img.src = `data:image/png;base64,${data}`;
    });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const X0 = Math.floor(img.width * f.x0);
    const X1 = Math.floor(img.width * f.x1);
    const Y0 = Math.floor(img.height * f.y0);
    const Y1 = Math.floor(img.height * f.y1);
    const W = X1 - X0;
    const H = Y1 - Y0;
    const d = ctx.getImageData(X0, Y0, W, H).data;
    const LX = Math.max(0, X0 - 10);
    const RX = Math.min(img.width - 1, X1 + 10);
    const refL = ctx.getImageData(LX, Y0, 1, H).data;
    const refR = ctx.getImageData(RX, Y0, 1, H).data;
    let r = 0; let g = 0; let b = 0; let n = 0;
    let lowest = -1; let highest = -1; let sumX = 0; let hits = 0;
    const raw = new Uint32Array(W * H);
    const on = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const t = RX > LX ? (X0 + x - LX) / (RX - LX) : 0;
        const rr = refL[y * 4] + (refR[y * 4] - refL[y * 4]) * t;
        const rg = refL[y * 4 + 1] + (refR[y * 4 + 1] - refL[y * 4 + 1]) * t;
        const rb = refL[y * 4 + 2] + (refR[y * 4 + 2] - refL[y * 4 + 2]) * t;
        r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
        raw[y * W + x] = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
        const off = Math.abs(d[i] - rr) + Math.abs(d[i + 1] - rg) + Math.abs(d[i + 2] - rb);
        if (off > 26) {
          on[y * W + x] = 1;
          lowest = y;
          if (highest < 0) highest = y;
          sumX += x; hits++;
        }
      }
    }
    return {
      r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n),
      lowest: lowest < 0 ? -1 : +((Y0 + lowest) / img.height).toFixed(4),
      highest: highest < 0 ? -1 : +((Y0 + highest) / img.height).toFixed(4),
      /** Vertical extent of the subject in the box, as a fraction of the frame. */
      extent: lowest < 0 ? 0 : +((lowest - highest) / img.height).toFixed(4),
      cx: hits ? +((X0 + sumX / hits) / img.width).toFixed(4) : -1,
      hits,
      raw: Array.from(raw),
      on: Array.from(on),
      w: W, h: H,
    };
  }, b64, { x0, y0, x1, y1 });
}

/**
 * Mean absolute per-channel difference between two `box` readings, over the
 * pixels that are SUBJECT in either of them.
 *
 * Averaging over the whole box instead is what made the first version of this
 * probe useless: a 7-unit plume covers a few per cent of any box wide enough to
 * be robust to framing, so a plume appearing or vanishing entirely came back as
 * a mean difference under half a code value — indistinguishable from noise.
 * Falls back to the whole box when neither frame has any subject in it, so an
 * empty-against-empty comparison still reads 0 rather than dividing by nothing.
 */
function meanAbsDiff(a, b) {
  if (a.raw.length !== b.raw.length) return Infinity;
  let s = 0; let n = 0;
  for (let i = 0; i < a.raw.length; i++) {
    if (!a.on[i] && !b.on[i]) continue;
    const p = a.raw[i]; const q = b.raw[i];
    s += Math.abs(((p >> 16) & 255) - ((q >> 16) & 255))
      + Math.abs(((p >> 8) & 255) - ((q >> 8) & 255))
      + Math.abs((p & 255) - (q & 255));
    n++;
  }
  if (n === 0) {
    for (let i = 0; i < a.raw.length; i++) {
      const p = a.raw[i]; const q = b.raw[i];
      s += Math.abs(((p >> 16) & 255) - ((q >> 16) & 255))
        + Math.abs(((p >> 8) & 255) - ((q >> 8) & 255))
        + Math.abs((p & 255) - (q & 255));
      n++;
    }
  }
  return +(s / (n * 3)).toFixed(3);
}

const LAB = (q) => `${HOST}/lab.html?${q}`;
/** The lab frames the fall in the middle; these two boxes are plume and sky. */
const PLUME = [0.36, 0.20, 0.64, 0.72];
const EMPTY = [0.02, 0.20, 0.24, 0.72];

// ---------------------------------------------------------------------------
// 1. IT MOVES, AND THE STAGE DOES NOT
//
// The whole point of the ticket is that the old fall never moved a pixel. Two
// frames half a second apart have to differ over the plume — and NOT differ
// over an empty patch of the same backdrop, which is the half that makes the
// first half mean something (a wobbling camera would pass on its own).
// ---------------------------------------------------------------------------
await page.goto(LAB('waterfall=1&bg=8fa8c0&fps=0'), { waitUntil: 'load' });
await page.waitForSelector('canvas');
await wait(2500);
const moveA = await box(...PLUME);
const emptyA = await box(...EMPTY);
await wait(500);
const moveB = await box(...PLUME);
const emptyB = await box(...EMPTY);
results.plumeDelta = meanAbsDiff(moveA, moveB);
results.backdropDelta = meanAbsDiff(emptyA, emptyB);
check(results.plumeDelta > 4, `the fall does not move: plume delta ${results.plumeDelta}`);
check(results.backdropDelta < 1.5,
  `the backdrop moves too, so the plume delta proves nothing: ${results.backdropDelta}`);

// ---------------------------------------------------------------------------
// 2. IT IS DETERMINISTIC UNDER `t=`
//
// `?t=` runs a fixed 1/60 loop and renders exactly one frame. Two loads of the
// same URL must produce the same pixels, or nothing in shots/ that contains a
// waterfall can be re-shot and compared. This is what catches a `Math.random()`
// or a `performance.now()` finding its way into the module.
// ---------------------------------------------------------------------------
await page.goto(LAB('waterfall=1&bg=8fa8c0&t=2'), { waitUntil: 'load' });
await page.waitForSelector('canvas');
await wait(1400);
const detA = await box(...PLUME);
await page.goto(LAB('waterfall=1&bg=8fa8c0&t=2'), { waitUntil: 'load' });
await page.waitForSelector('canvas');
await wait(1400);
const detB = await box(...PLUME);
results.frozenDelta = meanAbsDiff(detA, detB);
check(results.frozenDelta === 0,
  `?t= is not reproducible: two loads differ by ${results.frozenDelta}`);

// ---------------------------------------------------------------------------
// 3. `length` IS A PARAMETER — the first knob the ticket names
//
// Asserted as a MEASUREMENT: how many rows of the frame the water actually
// covers, with the camera pinned by `dist`/`height` so both arms are the same
// shot of two different falls.
//
// The EXTENT rather than the bottom row, because the lab hangs the lip at
// `y = fall` (a fall dropped from the origin falls out of the bottom of every
// shot), so a short fall's LIP is lower in frame too and the two ends move
// together. What cannot move together is how much sky the water covers.
// ---------------------------------------------------------------------------
// Narrow: `push` is 0 in these arms, so the plume runs straight down the middle
// and a tight box keeps the backdrop columns either side of it close to it.
const TALL = [0.42, 0.08, 0.58, 0.94];
const lenArm = async (fall) => {
  await page.goto(LAB(`waterfall=1&bg=8fa8c0&t=2&fall=${fall}&dist=120&height=30`),
    { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await wait(1400);
  return box(...TALL);
};
const long = await lenArm(40);
const short = await lenArm(8);
results.longExtent = long.extent;
results.shortExtent = short.extent;
check(long.hits > 0 && short.hits > 0, 'no plume found in one of the length arms');
// Five times the fall, and the projection is not linear in it, so the bar is
// well under 5 — but a fifth of the length cannot cover half the rows.
check(long.extent > short.extent * 2.5,
  `fall= did not change how far the water reaches: extent ${short.extent} at 8 `
  + `against ${long.extent} at 40`);

// ---------------------------------------------------------------------------
// 4. `lateralPush` IS A PARAMETER — the second knob the ticket names
//
// BOTH ENDS, because "it moved" alone would also pass for the whole plume
// sliding sideways. The push accumulates with depth, so the TAIL has to travel
// and the HEAD has to stay on the lip.
// ---------------------------------------------------------------------------
// Both bands sit inside the plume's measured vertical run at `fall=40` under
// this framing (about 0.29 to 0.62 of the frame); BOTTOM is wide because the
// whole point is that the tail travels sideways out of a narrow one.
const TOP = [0.30, 0.31, 0.70, 0.37];
const BOTTOM = [0.15, 0.54, 0.85, 0.61];
const arm = async (push) => {
  await page.goto(
    LAB(`waterfall=1&bg=8fa8c0&t=2&fall=40&push=${push}&dist=120&height=30&spray=0`),
    { waitUntil: 'load' },
  );
  await page.waitForSelector('canvas');
  await wait(1400);
  return { top: await box(...TOP), bottom: await box(...BOTTOM) };
};
const p0 = await arm(0);
const p12 = await arm(12);
results.headShift = +(p12.top.cx - p0.top.cx).toFixed(4);
results.tailShift = +(p12.bottom.cx - p0.bottom.cx).toFixed(4);
check(p0.bottom.hits > 0 && p12.bottom.hits > 0, 'no plume found in one of the push arms');
check(results.tailShift > 0.03,
  `push= did not move the tail: ${results.tailShift} of frame width`);
check(Math.abs(results.headShift) < results.tailShift * 0.5,
  `push= moved the whole plume rather than leaning it: head ${results.headShift} `
  + `against tail ${results.tailShift}`);

// ---------------------------------------------------------------------------
// 5. THE ISLAND DID NOT MOVE
//
// The regression the surgery in `buildRock` could have caused, as two numbers.
// `build` re-bases a model against its lowest voxel and `buildRock` adds that
// offset straight back, so `meshOriginY` must equal `meshMinY * cell` exactly —
// and `meshMinY` must still be the KEEL's depth, which is what says the deleted
// waterfall was never the thing setting it.
// ---------------------------------------------------------------------------
// UNDER `photo=1`, and that is not just for the clock. `SkyIsland.steer` returns
// early under photo, so the island stays at the home position it was built at —
// which is the position section 6 then has to aim a camera at. Reading its pose
// off an unpinned page and framing a pinned one points the lens at wherever the
// island had drifted to in the meantime, and a 7-unit plume is not forgiving
// about that. (tools/shot-sky.mjs gets away with the two-page split because it
// orbits the whole island at 1.5 radii.)
await page.goto(`${HOST}/?photo=1&hud=0&fs=0&fps=30`, { waitUntil: 'load' });
await page.waitForSelector('canvas');
await wait(6000);
const fall = await page.evaluate(() => window.__dbgSkyFall());
check(!!fall, '__dbgSkyFall reported nothing — is there a carried island?');
if (fall) {
  results.meshOriginY = fall.meshOriginY;
  results.meshMinY = fall.meshMinY;
  results.sprayAlive = fall.sprayAlive;
  results.tris = fall.tris;
  check(Math.abs(fall.meshOriginY - fall.meshMinY * fall.cell) < 1e-6,
    `the rock's rebase is not an identity: origin ${fall.meshOriginY} `
    + `against minY*cell ${fall.meshMinY * fall.cell}`);
  check(fall.meshMinY <= -60,
    `the rock's lowest voxel is ${fall.meshMinY} courses — the keel should set `
    + 'it (74-79), so something else is now the deepest thing in the model');
  check(fall.hasFall === 1, 'the island has no waterfall');
  check(fall.sprayAlive > 8, `the spray field is empty: ${fall.sprayAlive} alive`);
}

// ---------------------------------------------------------------------------
// 6. IT IS ACTUALLY DRAWN ON THE ISLAND, and it rides the `water` switch
//
// The picture half, and it needs the pair: the plume box must CHANGE when water
// is switched off, and a control box on the cliff beside it must not. Framed
// from the fall's own published anchor, so no coordinate here depends on the
// seed staying where it is.
// ---------------------------------------------------------------------------
const scene = await page.evaluate(() => ({
  fall: window.__dbgSkyFall(),
  sky: window.__dbgCarriers().all[0],
  spawn: window.__dbgTowns().spawn,
}));
if (scene.fall && scene.sky) {
  const { fall: f, sky, spawn } = scene;
  const cs = Math.cos(sky.yaw); const sn = Math.sin(sky.yaw);
  // The anchor is in the island's frame; `CarrierBody.toWorld` is this map.
  const wx = sky.x + f.anchorX * cs + f.anchorZ * sn;
  const wz = sky.z - f.anchorX * sn + f.anchorZ * cs;
  // Downstream, in world: the group's own +Z after the island's yaw.
  const b = f.bearing + sky.yaw;
  const dx = Math.sin(b); const dz = Math.cos(b);
  const D = 92;
  // `cam=` / `look=` are OFFSETS FROM spawnPoint. Standing off along the
  // bearing puts the plume dead centre with the cliff behind it.
  const cam = [wx + dx * D - spawn.x, sky.y + 5 - spawn.y, wz + dz * D - spawn.z];
  const look = [wx - spawn.x, sky.y - 24 - spawn.y, wz - spawn.z];
  const n3 = (v) => v.map((k) => k.toFixed(1)).join(',');
  const frame = `photo=1&hud=0&fs=0&fps=30&cam=${n3(cam)}&look=${n3(look)}`;
  // The plume runs down the middle; the control sits on the cliff to one side
  // of it, on rock the fall never crosses.
  const ON_PLUME = [0.45, 0.34, 0.55, 0.62];
  const ON_ROCK = [0.72, 0.34, 0.84, 0.55];

  await page.goto(`${HOST}/?${frame}`, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await wait(4200);
  const wetPlume = await box(...ON_PLUME);
  const wetRock = await box(...ON_ROCK);

  await page.goto(`${HOST}/?${frame}&water=0`, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await wait(4200);
  const dryPlume = await box(...ON_PLUME);
  const dryRock = await box(...ON_ROCK);

  results.plumeOnOff = meanAbsDiff(wetPlume, dryPlume);
  results.rockOnOff = meanAbsDiff(wetRock, dryRock);
  results.plumeWet = [wetPlume.r, wetPlume.g, wetPlume.b];
  results.plumeDry = [dryPlume.r, dryPlume.g, dryPlume.b];
  check(results.plumeOnOff > 10,
    `no waterfall in the frame: water=1 and water=0 differ by ${results.plumeOnOff}`);
  check(results.rockOnOff < 3,
    `water=0 changed the cliff too, so the plume difference is not the fall: `
    + `${results.rockOnOff}`);
  // ...and it must be WATER-coloured rather than a white smear: the SPEC teal
  // leads on blue over red by a wide margin.
  check(wetPlume.b > wetPlume.r + 25,
    `the plume is not reading as water: rgb ${results.plumeWet}`);
}

// ---------------------------------------------------------------------------
// 7. THE CHANNEL THAT FEEDS IT IS WATER — issue #89
//
// The stream on the deck used to be a course of flat blue voxels while the
// world it flies over ran a water shader with a swell, a depth ramp and a foam
// band. It is now that same shader (`SkyIsland.buildStream`), which is a claim
// with three halves and this section asserts all of them:
//
//   * there is a surface at all, and there are stones on its banks — read off
//     `__dbgSkyFall` rather than counted in pixels, because "how many boulders"
//     is not something a photograph can be asked;
//   * it is really drawn, and it rides the `water` switch with the fall: the
//     channel box must change between `water=1` and `water=0` while a patch of
//     turf beside it does not;
//   * what is drawn is WATER-coloured. Blue over red, against a bed that is
//     deliberately a pale warm gravel — so this fails if the surface silently
//     stops drawing and the probe photographs the bed.
// ---------------------------------------------------------------------------
if (scene.fall && scene.sky) {
  const { fall: f, sky, spawn } = scene;
  const cs = Math.cos(sky.yaw); const sn = Math.sin(sky.yaw);
  // The channel runs from the middle of the island out to the fall's anchor, so
  // the anchor IS its direction and its length. No seed-dependent number here.
  const len = Math.hypot(f.anchorX, f.anchorZ);
  const ux = f.anchorX / len; const uz = f.anchorZ / len;
  const at = (d, up) => [
    sky.x + ux * d * cs + uz * d * sn - spawn.x,
    sky.y + up - spawn.y,
    sky.z - ux * d * sn + uz * d * cs - spawn.z,
  ];
  const n3 = (v) => v.map((k) => k.toFixed(1)).join(',');
  // Standing over the head of the channel looking along it at the lip, which
  // puts the water down the middle of the frame and turf either side.
  const frame = `photo=1&hud=0&fs=0&fps=30&vol=0`
    + `&cam=${n3(at(len * 0.28, 12))}&look=${n3(at(len * 0.98, -2))}`;
  const ON_WATER = [0.46, 0.62, 0.55, 0.92];
  const ON_TURF = [0.78, 0.60, 0.90, 0.85];

  await page.goto(`${HOST}/?${frame}`, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await wait(4200);
  const wetCanal = await box(...ON_WATER);
  const wetTurf = await box(...ON_TURF);

  await page.goto(`${HOST}/?${frame}&water=0`, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await wait(4200);
  const dryCanal = await box(...ON_WATER);
  const dryTurf = await box(...ON_TURF);

  results.streamTris = fall.streamTris;
  results.canalStones = fall.canalStones;
  results.canalOnOff = meanAbsDiff(wetCanal, dryCanal);
  results.turfOnOff = meanAbsDiff(wetTurf, dryTurf);
  results.canalWet = [wetCanal.r, wetCanal.g, wetCanal.b];
  results.canalDry = [dryCanal.r, dryCanal.g, dryCanal.b];
  check(fall.streamTris > 100,
    `the channel has no water surface: ${fall.streamTris} triangles`);
  check(fall.canalStones > 10,
    `nothing lines the canal: ${fall.canalStones} stones`);
  check(results.canalOnOff > 10,
    `no water in the channel: water=1 and water=0 differ by ${results.canalOnOff}`);
  check(results.turfOnOff < 3,
    `water=0 changed the turf too, so the channel difference is not the stream: `
    + `${results.turfOnOff}`);
  check(wetCanal.b > wetCanal.r + 12,
    `the channel is not reading as water: rgb ${results.canalWet}`);
  // ...and the bed under it is NOT blue, which is the whole ticket: a warm
  // gravel that the shader colours, rather than a blue tile that needs no
  // shader. If this ever passes by accident the check above means nothing.
  check(dryCanal.b < dryCanal.r + 12,
    `the bed under the water is painted blue: rgb ${results.canalDry}`);
}

console.log(JSON.stringify({ ...results, failures: fails, pass: fails.length === 0 }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
