// Verifies the grass-disturbance field (src/world/sway.ts): a walking body
// parts the grass, the parted patch TRAILS the body and closes behind it, and a
// low-flying beast's downwash grows as its clearance over the ground falls.
//
// Usage: bun tools/test-sway.mjs        (dev server must be up)
//
// Everything here is a BAND or a CORRELATION, never an equality. The lag is a
// time constant sampled at whatever interval the host's frame rate gives, and a
// flyer's clearance is a damped chase with a bob on top — an exact number would
// be a different exact number on a faster machine. See AGENTS.md on
// frame-rate-sensitive assertions.
import { launchBrowser, newPage, wait } from './browser.mjs';

const URL = 'http://localhost:5187/?fps=30';
const browser = await launchBrowser();
const page = await newPage(browser, { width: 1280, height: 800 });
const results = {};

await page.goto(URL, { waitUntil: 'load' });
await page.waitForSelector('canvas');
await wait(4000);
await page.focus('canvas').catch(() => {});

const sway = () => page.evaluate(() => window.__dbgSway?.());
const pos = () => page.evaluate(() => window.__dbgPlayerPos?.());

// ---------- the field exists and is quiet before anything moves ----------
{
  const s = await sway();
  results.wiring = {
    present: !!s,
    frozenClock: s?.frozen ?? null,
    // The hero is standing in the world, so he holds a slot from the first
    // slice — "quiet" here means his own push is the only thing in it.
    slots: s?.slots?.length ?? null,
    maxPush: s?.maxPush ?? null,
  };
}

// ---------- walking: a slot follows the hero, and its wake lags ----------
{
  await page.keyboard.down('KeyW');
  await wait(900); // let the lag reach its steady state before sampling

  const lags = [];
  const pushes = [];
  let slotNearHero = 0;
  for (let i = 0; i < 10; i++) {
    await wait(150);
    const [s, p] = [await sway(), await pos()];
    if (!s || !p) continue;
    const hero = s.tracks.find((t) => t.id === -1);
    if (hero) lags.push(hero.lag);
    // The hero's own slot: the nearest one to him carrying a walk push.
    let best = null;
    for (const sl of s.slots) {
      if (sl.push <= 0) continue;
      const d = Math.hypot(sl.x - p.x, sl.z - p.z);
      if (!best || d < best.d) best = { d, push: sl.push };
    }
    if (best) { pushes.push(best.push); if (best.d < 2) slotNearHero++; }
  }
  await page.keyboard.up('KeyW');

  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  results.walking = {
    samples: lags.length,
    // 0.4-1.1 units: LAG_LAMBDA 9 puts the wake 0.66 behind a walk (6 u/s) and
    // 1.07 behind a sprint (9.6). Anything under 0.4 means the wake is pinned to
    // his feet and the "spreads" is gone; over 1.1 means it has detached.
    meanLag: mean(lags)?.toFixed(3),
    lagInBand: lags.length > 0 && lags.every((l) => l > 0.4 && l < 1.1),
    meanPush: mean(pushes)?.toFixed(3),
    // WALK_PUSH is 0.26 and the shader clamps the total at maxPush.
    pushPositive: pushes.length > 0 && pushes.every((p) => p > 0),
    slotTrackedHero: slotNearHero,
  };

  // ---------- release: the patch closes rather than snapping ----------
  await wait(600); // ~2.4 fade-out time constants
  const after = await sway();
  const hero = after?.tracks?.find((t) => t.id === -1);
  results.release = {
    // He is still standing there, so his slot stays — what must have gone is
    // the DISTANCE between him and his own wake.
    lagAfterStop: hero?.lag?.toFixed(3) ?? null,
    closed: hero ? hero.lag < 0.12 : null,
  };
}

// ---------- flying: a low beast washes the grass, harder the lower it is ----------
{
  // Cycle the primary slot through the roster looking for a flyer. Four of the
  // thirteen species are 'flying' (drakelet, frostwing, galebird, lumimoth), so
  // this finds one well inside a full lap.
  let found = null;
  for (let i = 0; i < 14 && !found; i++) {
    await page.keyboard.press('BracketRight');
    await wait(700);
    const s = await sway();
    const fly = s?.tracks?.find((t) => t.fly && t.id < 0);
    if (fly) found = fly.id;
  }

  const samples = [];
  if (found !== null) {
    // Drag the hero around: a follower's altitude is a damped chase of the
    // ground under it plus a look-ahead, so it only sweeps and climbs when it is
    // being made to keep up over changing terrain.
    await page.keyboard.down('KeyW');
    for (let i = 0; i < 24; i++) {
      await wait(220);
      const s = await sway();
      const t = s?.tracks?.find((x) => x.id === found);
      if (!t) continue;
      let wash = 0;
      for (const sl of s.slots) if (sl.wash > wash) wash = sl.wash;
      samples.push({ clearance: t.clearance, climb: t.climb, wash });
    }
    await page.keyboard.up('KeyW');
  }

  const washed = samples.filter((s) => s.wash > 0);
  // Correlation, not a threshold: assert that the LOWER half of the clearance
  // samples washed harder than the upper half, which holds at any frame rate.
  //
  // THE CLIMB TERM IS DIVIDED OUT FIRST, and it has to be. The shipped wash is
  // `near(clearance) * gain(climb)` (sway.ts), and those two move TOGETHER on a
  // follower being dragged over rising ground: it climbs, which raises the gain,
  // and climbing is precisely what puts it higher, which lowers `near`. Reading
  // raw wash against clearance therefore measures the two effects fighting and
  // reports whichever won on the day — it came out 0.655 low against 0.697 high,
  // i.e. "backwards", on a build whose clearance response is exactly right.
  // Normalising by the gain the sample's own `climb` implies leaves `near`,
  // which is the single-variable claim this case is actually making.
  const CLIMB_REF = 3.0, CLIMB_EXTRA = 1.35; // must match sway.ts
  const gainOf = (s) => 1 + Math.min(1, Math.max(0, s.climb / CLIMB_REF)) * CLIMB_EXTRA;
  const byClear = [...washed].sort((a, b) => a.clearance - b.clearance);
  const half = Math.floor(byClear.length / 2);
  const meanWash = (a) =>
    (a.length ? a.reduce((x, y) => x + y.wash / gainOf(y), 0) / a.length : 0);
  const low = meanWash(byClear.slice(0, half));
  const high = meanWash(byClear.slice(byClear.length - half));

  results.flying = {
    flyerFound: found,
    samples: samples.length,
    washing: washed.length,
    meanClearance: washed.length
      ? (washed.reduce((a, b) => a + b.clearance, 0) / washed.length).toFixed(3) : null,
    /** Climb-normalised, so these are the clearance response alone. */
    lowClearanceWash: low.toFixed(3),
    highClearanceWash: high.toFixed(3),
    // CLEAR_HI 3.2 -> CLEAR_LO 0.55, so a lower flyer must wash harder.
    washRisesAsItDrops: half > 0 && low > high,
    maxClimb: samples.length ? Math.max(...samples.map((s) => s.climb)).toFixed(3) : null,
  };
}

// ---------- policy: the slot budget and the clamp both hold ----------
{
  const s = await sway();
  results.budget = {
    slots: s?.slots?.length ?? null,
    withinBudget: (s?.slots?.length ?? 99) <= 6,
    // The uniform carries the pre-clamp push; the shader clamps the SUM. What
    // must hold here is that no single slot is already over it on its own.
    noSlotOverClamp: (s?.slots ?? []).every((sl) => sl.push <= s.maxPush + 1e-6),
    tracks: s?.tracks?.length ?? null,
    areaRadius: s?.area?.r?.toFixed(2) ?? null,
  };
}

await page.screenshot({ path: 'shots/_sway-walk.png' });

console.log(JSON.stringify(results, null, 2));
await browser.close();
