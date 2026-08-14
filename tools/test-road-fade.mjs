// The road ribbons dissolve into sky WITH the ground (the report behind this
// probe: flying along a spur, the carriageway kept rendering hundreds of units
// past where the far clipmap had dissolved, a grey band hanging in open sky).
// The fix shares DistantTerrain's horizon-fade uniforms with the ribbon
// material and the road lamp glow — this file holds the ribbon half of that to
// what the frame actually draws.
//
//   bun tools/test-road-fade.mjs   (dev server must be up)
//
// The measurement is a toggle A/B inside one page load, in photo mode with the
// lens pinned: screenshot with ribbons shown, hidden (`__dbgPathRibbons`), and
// shown again. The on/on pair is the noise floor — whatever the water shimmer
// and light drift move between two identical configurations. Both halves of the
// pair are asserted:
//
//   FAR  — the camera aims at a road point past `horizonFadeEnd`. Hiding every
//          ribbon must change nothing beyond the noise floor: a road ends
//          BEFORE the ground around it starts thinning (`roadFadeEnd` closes
//          where `horizonFadeStart` opens — asserted from the same readout).
//   NEAR — the same toggle aimed at a road point inside `roadFadeStart`
//          must visibly remove the road. This is the control that proves the
//          statistic can see a ribbon at all (and that the fade did not
//          over-reach and erase roads off the still-rendered ground).
//
// Road points come from `__dbgPaths().paths[].pts` at runtime, not from baked
// coordinates, so the probe survives the road planner re-routing a spur.
import { launchBrowser, newPage, wait, frame, whenPlaying } from "./browser.mjs";
import { BASE as HOST, NO_WARMUP } from "./target.mjs";

const W = 1280;
const H = 800;
/** Central window, as fractions of the frame: the aimed road point projects here. */
const BOX = [0.35, 0.65, 0.35, 0.65];
/** A channel step below this is settling noise, not a removed road. */
const CHANGED = 12;

const fails = [];
const check = (ok, message) => {
  if (!ok) {
    fails.push(message);
  }
};

const browser = await launchBrowser();
const results = {};

/** Mean |Δ| per channel and changed-pixel fraction between two shots, in BOX. */
async function diffShots(page, b64a, b64b) {
  return page.evaluate(
    async (da, db, box, cut) => {
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page, not this module
      const load = (data) =>
        new Promise((res, rej) => {
          const img = new Image();
          img.addEventListener("load", () => res(img));
          img.addEventListener("error", rej);
          img.src = `data:image/png;base64,${data}`;
        });
      const [a, b] = await Promise.all([load(da), load(db)]);
      const c = document.createElement("canvas");
      c.width = a.width;
      c.height = a.height;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      const x0 = Math.floor(a.width * box[0]);
      const w = Math.floor(a.width * box[1]) - x0;
      const y0 = Math.floor(a.height * box[2]);
      const h = Math.floor(a.height * box[3]) - y0;
      ctx.drawImage(a, 0, 0);
      const pa = ctx.getImageData(x0, y0, w, h).data;
      ctx.drawImage(b, 0, 0);
      const pb = ctx.getImageData(x0, y0, w, h).data;
      let sum = 0;
      let changed = 0;
      for (let i = 0; i < pa.length; i += 4) {
        const dr = Math.abs(pa[i] - pb[i]);
        const dg = Math.abs(pa[i + 1] - pb[i + 1]);
        const db2 = Math.abs(pa[i + 2] - pb[i + 2]);
        sum += dr + dg + db2;
        if (dr > cut || dg > cut || db2 > cut) {
          changed++;
        }
      }
      const px = pa.length / 4;
      return { mean: +(sum / (px * 3)).toFixed(3), changed: +(changed / px).toFixed(5) };
    },
    b64a,
    b64b,
    BOX,
    CHANGED,
  );
}

/** The far field is built and the streaming ring is full — safe to measure. */
const settled = (page) =>
  page.waitForFunction(
    () => {
      const d = window.__dbgDistantTerrain?.();
      const z = window.__dbgZone?.();
      return d?.ready === true && d?.building === false && z?.streaming === false;
    },
    { timeout: 60_000 },
  );

/** on / off / on with a settled frame between: delta vs the do-nothing noise. */
async function toggleAB(page) {
  const settle = async () => {
    await frame(page);
    await wait(250);
  };
  await settle();
  const on1 = await page.screenshot({ encoding: "base64" });
  await page.evaluate(() => window.__dbgPathRibbons(false));
  await settle();
  const off = await page.screenshot({ encoding: "base64" });
  await page.evaluate(() => window.__dbgPathRibbons(true));
  await settle();
  const on2 = await page.screenshot({ encoding: "base64" });
  return {
    delta: await diffShots(page, on1, off),
    noise: await diffShots(page, on1, on2),
  };
}

// ---- Load 1: where the roads are and where the world stops rendering -------
let spawn;
let farPt;
let nearPt;
let bandPt;
let fade;
{
  const page = await newPage(browser, { width: W, height: H });
  page.on("pageerror", (e) => fails.push(`page error: ${e.message}`));
  await page.goto(`${HOST}/?menu=0&fs=0&vol=0&${NO_WARMUP}`, { waitUntil: "load" });
  await whenPlaying(page);
  await page.waitForFunction(() => window.__dbgZone?.().streaming === false, { timeout: 60_000 });
  const scout = await page.evaluate(() => ({
    distant: window.__dbgDistantTerrain?.(),
    spawn: window.__dbgTowns?.().spawn,
    paths: window.__dbgPaths?.().paths,
  }));
  await page.close();

  fade = {
    start: scout.distant?.horizonFadeStart,
    end: scout.distant?.horizonFadeEnd,
    roadStart: scout.distant?.ringFadeStart,
    roadEnd: scout.distant?.ringFadeEnd,
  };
  check(
    typeof fade.start === "number" && typeof fade.end === "number" && fade.end > fade.start,
    `distant terrain reports no horizon fade band: ${JSON.stringify(scout.distant)}`,
  );
  // The single render-distance authority: roads must be DONE before the ground
  // starts thinning, so a road is never drawn over dissolving or absent ground.
  check(
    typeof fade.roadEnd === "number" && fade.roadEnd <= fade.start && fade.roadStart < fade.roadEnd,
    `the ring band does not close before the ground band opens: ${JSON.stringify(fade)}`,
  );
  spawn = scout.spawn;
  const pts = (scout.paths ?? [])
    .filter((p) => p.draw && p.profile === "path:road")
    .flatMap((p) => p.pts);
  check(pts.length > 20, `the drawn network yielded ${pts.length} centreline samples`);

  // Camera distance is what the fade sees; the lens sits CAM_UP above spawn.
  const nearest = (target) => {
    let best = null;
    let bestErr = Infinity;
    for (const [x, y, z] of pts) {
      const err = Math.abs(Math.hypot(x - spawn.x, z - spawn.z) - target);
      if (err < bestErr) {
        bestErr = err;
        best = [x, y, z];
      }
    }
    return { best, err: bestErr };
  };
  // FAR AIMS DEEP past the band, because the box around the aim point spans a
  // stretch of road nearer than the point itself: aimed at fadeEnd + 90 the
  // box's lower rows landed inside the 396..516 dissolve band, where a ribbon
  // legitimately still draws half its pixels, and the first run failed on that.
  const maxOut = pts.reduce((m, [x, , z]) => Math.max(m, Math.hypot(x - spawn.x, z - spawn.z)), 0);
  const farTarget = Math.min(fade.end + 200, maxOut - 40);
  check(
    farTarget >= fade.end + 120,
    `the network ends ${Math.round(maxOut)} out — too short to frame past the fade`,
  );
  const far = nearest(farTarget);
  const near = nearest(Math.max(60, fade.roadStart - 40));
  // The reported frame: road drawn over ground that is itself dissolving. The
  // band lens brackets slants in [groundStart..groundEnd], past the road band.
  const band = nearest(fade.start + 104);
  check(far.err < 60, `no drawn road near ${Math.round(farTarget)} units out (${far.err})`);
  check(near.err < 40, `no drawn road inside the road band (${near.err})`);
  check(band.err < 60, `no drawn road near the ground dissolve band (${band.err})`);
  farPt = far.best;
  nearPt = near.best;
  bandPt = band.best;
  results.scout = { fade, farPt, nearPt, bandPt };
}

if (fails.length === 0) {
  // ---- Loads 2 and 3: the pinned lens, far then near ------------------------
  // The far lens flies HIGH: the fade reads CAMERA distance, so altitude puts
  // even the box's lowest rows on slant distances past fadeEnd. The near lens
  // stays low for the opposite reason — from 400 up the slant to the 250-unit
  // ring would itself be inside the dissolve band.
  const shoot = async (pt, camUp) => {
    const look = `${(pt[0] - spawn.x).toFixed(1)},${(pt[1] - spawn.y).toFixed(1)},${(pt[2] - spawn.z).toFixed(1)}`;
    const url =
      `${HOST}/?photo=1&hud=0&vol=0&beasts=0&enemies=0&clouds=0&${NO_WARMUP}` +
      `&cam=0,${camUp},0&look=${look}`;
    const page = await newPage(browser, { width: W, height: H });
    page.on("pageerror", (e) => fails.push(`page error: ${e.message}`));
    await page.goto(url, { waitUntil: "load" });
    await whenPlaying(page);
    await settled(page);
    const ab = await toggleAB(page);
    await page.close();
    return ab;
  };

  results.far = await shoot(farPt, 400);
  // 300 up puts the whole box on slants past roadFadeEnd while the ground under
  // them is mid-dissolve — the exact frame of the report this probe exists for.
  results.band = await shoot(bandPt, 300);
  results.near = await shoot(nearPt, 56);

  const { far, band, near } = results;
  check(
    far.delta.mean <= far.noise.mean + 0.15 && far.delta.changed <= far.noise.changed + 0.002,
    `hiding the ribbons changed the frame past horizonFadeEnd ` +
      `(delta ${JSON.stringify(far.delta)} vs noise ${JSON.stringify(far.noise)}) — ` +
      `the road is rendering beyond where the ground dissolves`,
  );
  check(
    band.delta.mean <= band.noise.mean + 0.15 && band.delta.changed <= band.noise.changed + 0.002,
    `hiding the ribbons changed the frame over the ground's dissolve band ` +
      `(delta ${JSON.stringify(band.delta)} vs noise ${JSON.stringify(band.noise)}) — ` +
      `a road is drawn on ground that is itself dissolving`,
  );
  check(
    near.delta.changed > near.noise.changed + 0.01,
    `hiding the ribbons changed ${JSON.stringify(near.delta)} of the near frame ` +
      `(noise ${JSON.stringify(near.noise)}) — either the lens missed the road and this ` +
      `probe is blind, or the fade erased roads off ground that still renders`,
  );
}

await browser.close();
console.log(JSON.stringify(results, null, 2));
if (fails.length) {
  console.error(`\nFAIL (${fails.length})`);
  for (const f of fails) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}
console.log("\nOK");
