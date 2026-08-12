// The cached static shadow map (src/core/shadow-cache.ts).
//
//   bun tools/test-shadowcache.mjs          (dev server must be up)
//
// A cache is the easiest optimisation in a renderer to get wrong in a way that
// looks right: the frame gets cheaper, the shadows are still there, and the one
// that stopped updating is the one nobody was looking at. So this file asks
// three different questions and only one of them is about speed.
//
// 1. IS THE PICTURE THE SAME? The cache must be invisible. `shadowcache=0` is
//    the only flag in core/flags.ts that claims to move no pixels, and this
//    holds it to that — with a CONTROL, because "these two frames match" passes
//    just as well when the measurement is blind. Switching shadows off entirely
//    has to move the same statistic by a lot, or the statistic cannot see
//    shadows and the agreement means nothing.
//
// 2. DOES A MOVING THING STILL CAST A MOVING SHADOW? This is the failure the
//    whole design is arranged around — an actor baked into the static half
//    drags a frozen smear behind it. The hero is stepped LESS than
//    SHADOW_RECENTER (engine.ts) so the shadow box cannot follow him, the
//    rebuild counter is checked not to have moved, and his shadow has to have
//    moved anyway. That can only have come from the per-frame dynamic pass.
//
// 3. IS IT ACTUALLY CACHING? Draw calls and triangles, which are exact and free
//    of the noise a millisecond figure carries.
//
// BOTH PICTURE SECTIONS RUN ON THEIR OWN PAGE, in photo mode with `beasts=0`
// and `enemies=0`, and every part of that is load-bearing. Photo mode pins the
// camera — under the gameplay camera the hero drags the lens with him, so his
// shadow lands on the same PIXELS however far he walks, and the first version
// of section 2 measured a 1.71 luma change and concluded the shadow was stuck.
// It also freezes the wind clock, and dropping the beasts and the wild spawns
// leaves the hero as the only thing in frame that moves at all, which is what
// takes section 1's agreement from "close" to "exact". The framing is the
// spawn road: bare, flat, sunlit, and his cast shadow is the only dark thing on
// it.
//
// The frame cost is REPORTED and not asserted, and it is measured by
// alternating inside ONE page load rather than across two. That is not fussiness
// — an early cross-load version of this measurement "showed" the shadow pass
// costing 2.15 ms, which was two page loads a minute apart on a desktop plus a
// second change in the same commit. Alternating every 2.5 s over one stretch of
// world, the drift cancels and the paired sign is readable.
import { launchBrowser, newPage, wait, glRenderer } from "./browser.mjs";
import { BASE as HOST } from "./target.mjs";

const W = 1280;
const H = 800;
const BASE = `${HOST}/`;
const PLAY = `${BASE}?menu=0&fs=0&perf=1&debug=1`;
// cam/look are offsets from world.spawnPoint, not world coordinates.
const PHOTO = `${BASE}?photo=1&hud=0&beasts=0&enemies=0&cam=0,10,12&look=0,1,0`;
/** Must be under SHADOW_RECENTER (engine.ts) — see question 2. */
const NUDGE = 3;

const results = {};
const fails = [];
const check = (ok, msg) => {
  if (!ok) {
    fails.push(msg);
  }
};

const browser = await launchBrowser();

const shadows = (p) => p.evaluate(() => window.__dbgShadows());
const setCache = (p, on) => p.evaluate((v) => window.__dbgShadowCache(v), on);
const draws = (p) =>
  p.evaluate(() => {
    const el = [...document.body.children].find(
      (c) => c instanceof HTMLDivElement && (c.textContent || "").startsWith("FPS"),
    );
    const m = (el?.textContent || "").match(/draws\s+([\d,]+)\s+tris\s+([\d,]+)/);
    return m ? { draws: +m[1].replace(/,/g, ""), tris: +m[2].replace(/,/g, "") } : null;
  });

/**
 * The frame around the hero, reduced to what a shadow does to it.
 *
 * `dark` is the fraction of the window under a luma threshold — on bare sunlit
 * road that is his silhouette and his cast shadow and nothing else — and
 * `cx`/`cy` are that region's centroid in window pixels, which is what moves
 * when a shadow follows its caster.
 *
 * The screenshot is taken by the BROWSER and handed back into the page to be
 * decoded, for the reason test-dive.mjs gives: a WebGL context without
 * `preserveDrawingBuffer` hands back an empty buffer through `drawImage`.
 */
async function frame(page, box, dim) {
  const b64 = await page.screenshot({ encoding: "base64" });
  return page.evaluate(
    async (data, b, cut) => {
      const img = new Image();
      await new Promise((res, rej) => {
        img.addEventListener("load", res);
        img.addEventListener("error", rej);
        img.src = `data:image/png;base64,${data}`;
      });
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const x0 = Math.floor(img.width * b[0]);
      const x1 = Math.floor(img.width * b[1]);
      const y0 = Math.floor(img.height * b[2]);
      const y1 = Math.floor(img.height * b[3]);
      const w = x1 - x0;
      const h = y1 - y0;
      const d = ctx.getImageData(x0, y0, w, h).data;
      let sum = 0;
      let dark = 0;
      let sx = 0;
      let sy = 0;
      for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        sum += l;
        if (l < cut) {
          dark++;
          sx += p % w;
          sy += Math.floor(p / w);
        }
      }
      return {
        meanLuma: +(sum / (w * h)).toFixed(2),
        dark: +(dark / (w * h)).toFixed(4),
        cx: dark ? +(sx / dark).toFixed(1) : -1,
        cy: dark ? +(sy / dark).toFixed(1) : -1,
        px: dark,
      };
    },
    b64,
    box,
    dim,
  );
}

// ============================================================================
// The picture: photo mode, fixed lens, the hero the only moving thing in frame.
// ============================================================================
{
  const page = await newPage(browser, { width: W, height: H });
  page.on("pageerror", (e) => console.error("[page]", e.message));
  await page.goto(PHOTO, { waitUntil: "load" });
  await page.waitForSelector("canvas");
  await wait(9000);
  results.gl = await glRenderer(page);

  // TWO windows, because the two questions want opposite things.
  //
  // WIDE is most of the frame and asks whether the picture changed; its
  // threshold of 90 is where cast shadow sits against sunlit ground (measured
  // over this framing: 21% of the frame is under it, and turning shadows off
  // moves that by a fifth).
  //
  // TIGHT is the stretch of road the hero stands on, at a threshold of 64,
  // which measured picks out 4.8% of that window — his silhouette and his cast
  // shadow, and nothing else, on ground that is otherwise bare and in full sun.
  // That is what makes a CENTROID meaningful in section 2.
  const WIDE = [0.05, 0.95, 0.05, 0.95];
  const TIGHT = [0.34, 0.62, 0.38, 0.64];
  const SHADE = 90;
  const HERO = 64;

  // ---------- 1. the same picture, with a control and a noise floor ---------
  await setCache(page, true);
  await wait(700);
  const on = await frame(page, WIDE, SHADE);
  await setCache(page, false);
  await wait(700);
  const off = await frame(page, WIDE, SHADE);
  await setCache(page, true);
  await wait(700);
  const back = await frame(page, WIDE, SHADE);
  await page.evaluate(() => window.__dbgGfx("shadows", false));
  await wait(1400);
  const none = await frame(page, WIDE, SHADE);
  await page.evaluate(() => window.__dbgGfx("shadows", true));
  await wait(1400);

  // `noise` is on-vs-on: two frames of the identical configuration, so it is
  // whatever the hero's idle animation moved between shots. The cache is
  // allowed exactly that much and a hair more; anything it changes beyond what
  // doing nothing changes is the cache changing the picture.
  const noise = Math.abs(on.dark - back.dark);
  const delta = Math.abs(on.dark - off.dark);
  const control = Math.abs(on.dark - none.dark);
  results.picture = {
    cacheOn: on,
    cacheOff: off,
    restored: back,
    shadowsOff: none,
    noise: +noise.toFixed(4),
    delta: +delta.toFixed(4),
    control: +control.toFixed(4),
  };
  check(
    delta <= noise + 0.004,
    `the cache moved the shadowed fraction by ${delta.toFixed(4)}, against a ` +
      `do-nothing noise floor of ${noise.toFixed(4)} — it must be invisible`,
  );
  check(
    Math.abs(on.meanLuma - off.meanLuma) < 2,
    `the cache moved mean luma by ${Math.abs(on.meanLuma - off.meanLuma).toFixed(2)}`,
  );
  check(
    control > 0.02,
    `switching shadows off moved the shadowed fraction by only ${control.toFixed(4)} ` +
      "— this statistic cannot see shadows, so the agreement above proves nothing",
  );

  // ---------- 2. a moving actor still casts a moving shadow ----------------
  const before = await shadows(page);
  const a = await frame(page, TIGHT, HERO);
  const p = await page.evaluate(() => window.__dbgPlayerPos());
  // Along the sun's azimuth, so he steps out of his own shadow rather than
  // along it. SUN_OFFSET is (170, 160, 113); normalised in xz, (0.833, 0.554).
  await page.evaluate((x, z) => window.__dbgTp(x, z), p.x + NUDGE * 0.833, p.z + NUDGE * 0.554);
  await wait(1200);
  const b = await frame(page, TIGHT, HERO);
  const after = await shadows(page);
  const moved = Math.hypot(b.cx - a.cx, b.cy - a.cy);
  results.moving = {
    rebuildsBefore: before.rebuilds,
    rebuildsAfter: after.rebuilds,
    from: { cx: a.cx, cy: a.cy, dark: a.dark },
    to: { cx: b.cx, cy: b.cy, dark: b.dark },
    centroidMovedPx: +moved.toFixed(1),
  };
  check(
    after.rebuilds === before.rebuilds,
    `the cache rebuilt ${after.rebuilds - before.rebuilds} times during a ${NUDGE}-unit ` +
      "step — the step has to be smaller than SHADOW_RECENTER or this proves nothing",
  );
  check(
    b.dark > 0.005,
    `the hero has no dark pixels left after the step (${b.dark}) — he walked out of frame`,
  );
  // 40 px against a measured ~60 for a 3-unit step at this framing. The floor
  // is what discriminates: if his shadow were frozen and only his body moved,
  // the centroid of the two together moves roughly half as far.
  check(
    moved > 40,
    `the hero's dark region moved ${moved.toFixed(1)} px when he stepped ${NUDGE} units ` +
      "with the lens pinned — his shadow is baked into the static cache",
  );

  await page.close();
}

// ============================================================================
// The rest, on an ordinary game page.
// ============================================================================
{
  const page = await newPage(browser, { width: W, height: H });
  page.on("pageerror", (e) => console.error("[page]", e.message));
  await page.goto(PLAY, { waitUntil: "load" });
  await page.waitForSelector("canvas");
  await wait(9000);

  // ---------- it is on, and it is caching something worth caching -----------
  const s = await shadows(page);
  results.boot = s;
  check(s.enabled === true, "shadows are not on");
  check(s.cached === true, "the static shadow cache is not running");
  check(s.size === 4096, `the cache is ${s.size} px, not the light's 4096`);
  // A FLOOR, not the measured value (171-189 near the spawn): what is in frame
  // is a property of where the hero is, and the assertion only has to ask
  // whether the world is on the cached side at all.
  check(
    s.staticCasters > 120,
    `only ${s.staticCasters} casters are marked static — the world is not being cached`,
  );
  check(s.dynamic > 0, "no dynamic casters at all — the hero has no shadow to draw");

  // ---------- the layer split did not delete the world from a raycast ------
  // shadow-cache.ts moves every chunk mesh off layer 0, and a Raycaster starts
  // on layer 0 alone. This is the cheap version of what test-road.mjs measures
  // properly, and it is here because it is the failure THIS change causes.
  const surf = await page.evaluate(() => {
    const p = window.__dbgPlayerPos();
    return window.__dbgSurfaceY(p.x, p.z);
  });
  results.raycast = surf;
  check(
    surf.hit !== null,
    "a downward raycast at the hero hits nothing — static geometry left layer 0 unreachable",
  );

  // ---------- 3. it removes work, and the switch round-trips ----------------
  await setCache(page, false);
  await wait(1200);
  const dOff = await draws(page);
  await setCache(page, true);
  await wait(1200);
  const dOn = await draws(page);
  results.draws = { cacheOff: dOff, cacheOn: dOn, saved: dOff.draws - dOn.draws };
  // FLOORS. The absolute counts are whatever is in frame; what the guard is for
  // is "did the static half stop being redrawn at all".
  check(
    dOff.draws - dOn.draws >= 40,
    `the cache saved ${dOff.draws - dOn.draws} draw calls, expected at least 40`,
  );
  check(
    dOff.tris - dOn.tris >= 400000,
    `the cache saved ${dOff.tris - dOn.tris} triangles, expected at least 400k`,
  );

  // ---------- the interleaved cost A/B: reported, not asserted -------------
  await page.focus("canvas").catch(() => {});
  await page.keyboard.down("KeyW");
  await wait(3000);
  const SLICE = 2500;
  const TAIL = Math.floor(SLICE / 10);
  const acc = { on: [], off: [] };
  const slice = async (on) => {
    await setCache(page, on);
    await wait(500 + SLICE);
    const d = await page.evaluate(() => window.__dbgPerf());
    const rows = d.rows.slice(-TAIL);
    const c = d.sections.indexOf("cpu");
    return rows.reduce((x, r) => x + r[c], 0) / rows.length;
  };
  for (let i = 0; i < 6; i++) {
    // Alternate the ORDER too, so a monotonic drift cannot favour one side.
    for (const on of i % 2 === 0 ? [true, false] : [false, true]) {
      acc[on ? "on" : "off"].push(await slice(on));
    }
  }
  await page.keyboard.up("KeyW");
  const diff = acc.on.map((v, i) => v - acc.off[i]);
  results.cost = {
    cpuOn: acc.on.map((v) => +v.toFixed(3)),
    cpuOff: acc.off.map((v) => +v.toFixed(3)),
    pairedMeanMs: +(diff.reduce((x, y) => x + y) / diff.length).toFixed(3),
    cheaper: `${diff.filter((v) => v < 0).length}/${diff.length}`,
  };
  // perRebuild over a real walk, reported rather than asserted for the same
  // reason the millisecond figure is: it is a function of how much ground the
  // hero covered, which is a function of the frame rate of the host.
  results.walked = await shadows(page);
  await page.close();
}

await browser.close();
console.log(JSON.stringify(results, null, 2));
if (fails.length) {
  console.error(`\nFAIL (${fails.length})`);
  for (const f of fails) {
    console.error(" -", f);
  }
  process.exit(1);
}
console.log("\nOK");
