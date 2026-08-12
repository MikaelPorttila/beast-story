// Verifies the nature parameters (src/world/nature.ts): the baseline is the
// world as designed, a parameter changes what is actually GROWN, and an area
// multiplies the baseline rather than replacing it.
//
// Usage: bun tools/test-nature.mjs      (dev server must be up)
//
// EVERY ASSERTION IS A VERTEX COUNT, never the stored setting. A parameter
// table is the same class of thing as a settings panel and fails the same way:
// the value is stored, the snapshot reports it, and the placement loop never
// hears about it. So `__dbgNature().census` is what is read here — the two prop
// meshes' vertices, summed off the SCENE — and the snapshot is consulted only
// to check the arithmetic of the layering, never as evidence that anything grew.
//
// THE IDENTITY RUN IS THE CONTROL, and it is the section that makes the rest
// mean anything. Setting a parameter to its own baseline rebuilds every chunk
// and must land on the same census: without it, "grass 0 dropped the count" is
// equally consistent with "a rebuild drops the count", and the streamer's own
// progress would be indistinguishable from the feature working.
//
// Exits non-zero.
import { launchBrowser, newPage, wait } from "./browser.mjs";
import { BASE as HOST } from "./target.mjs";

const browser = await launchBrowser();
const results = {};
const fails = [];
const check = (ok, msg) => {
  if (!ok) {
    fails.push(msg);
  }
};

async function openGame(query) {
  const page = await newPage(browser, { width: 1280, height: 800 });
  page.on("pageerror", (e) => console.error("[page]", e.message));
  await page.goto(`${HOST}/?menu=0&fs=0${query}`, { waitUntil: "load" });
  await page.waitForSelector("canvas");
  return page;
}

/**
 * Wait for the streamer to finish, then read the census.
 *
 * Polls until the loaded-chunk count and both vertex totals stop moving for
 * three consecutive reads. A fixed sleep cannot work here: a rebuild re-streams
 * ~90 chunks against a per-frame build budget, so how long it takes is a
 * property of the host's GPU — which is exactly the variable AGENTS.md warns
 * every frame-sensitive tool about.
 */
async function settle(page, tries = 60) {
  let last = null;
  let same = 0;
  for (let i = 0; i < tries; i++) {
    await wait(500);
    const now = await page.evaluate(() => window.__dbgNature());
    const key = JSON.stringify(now.census);
    if (key === last && now.census.chunks > 0) {
      if (++same >= 2) {
        return now;
      }
    } else {
      same = 0;
    }
    last = key;
  }
  return page.evaluate(() => window.__dbgNature());
}

const setNature = (page, id, v, area) =>
  page.evaluate(
    ([i, val, a]) => window.__dbgSetNature(i, val, a ?? undefined),
    [id, v, area ?? null],
  );

const page = await openGame("");

// ---------- the shipped world is the baseline -------------------------------
const base = await settle(page);
results.baseline = {
  isDefault: base.isDefault,
  values: base.baseline,
  census: base.census,
};
check(base.isDefault === true, "a fresh load reports a non-default nature table");
check(
  Object.values(base.baseline).every((v) => v === 1),
  `the shipped baseline is not all 1: ${JSON.stringify(base.baseline)}`,
);
check(
  base.census.chunks > 20 && base.census.grassVerts > 0 && base.census.propVerts > 0,
  `nothing streamed to measure: ${JSON.stringify(base.census)}`,
);

// ---------- CONTROL: setting the baseline to its own value changes nothing ---
// The rebuild happens (the listener fires on any set), so this prices the
// rebuild itself. Everything below is read against this tolerance.
{
  await setNature(page, "grass", 1);
  const same = await settle(page);
  const drift =
    Math.abs(same.census.grassVerts - base.census.grassVerts) / Math.max(1, base.census.grassVerts);
  results.identity = { census: same.census, drift: +drift.toFixed(4) };
  check(
    drift < 0.02,
    `a rebuild at the baseline moved the grass by ${(drift * 100).toFixed(1)}% ` +
      "— the census is not stable enough to judge anything else by",
  );
}

// ---------- grass 0 empties the sward ---------------------------------------
{
  await setNature(page, "grass", 0);
  const off = await settle(page);
  const kept = off.census.grassVerts / Math.max(1, base.census.grassVerts);
  results.grassOff = { census: off.census, keptFraction: +kept.toFixed(3) };
  // NOT zero, and it must not be: the soft mesh also carries reeds, shells,
  // driftwood and fallen sticks, none of which is grass. What the parameter
  // owns is the meadow, which is the large majority of it.
  check(kept < 0.2, `grass 0 left ${(kept * 100).toFixed(1)}% of the sward standing`);
  await setNature(page, "grass", 1);
  await settle(page);
}

// ---------- trees 0 empties the solid mesh ----------------------------------
{
  await setNature(page, "trees", 0);
  const off = await settle(page);
  const kept = off.census.propVerts / Math.max(1, base.census.propVerts);
  results.treesOff = { census: off.census, keptFraction: +kept.toFixed(3) };
  // The solid mesh is trees AND boulders, logs, hedges and mushrooms, so the
  // floor is looser than the sward's. A tree is by far the largest object in it.
  check(kept < 0.6, `trees 0 left ${(kept * 100).toFixed(1)}% of the prop mesh standing`);
  await setNature(page, "trees", 1);
  await settle(page);
}

// ---------- an AREA multiplies the baseline ---------------------------------
// The claim under test is the issue's own sentence: the baseline is the base,
// and an area adjusts FROM it. So halve the baseline, then hand one area a x2 —
// the resolved value there is back at 1, and the count has to come back up with
// it. Ordering rather than an absolute figure, because the streamed set is a
// mix of biomes and only the plains chunks in it are governed by the override.
{
  await setNature(page, "grass", 0.5);
  const half = await settle(page);
  await setNature(page, "grass", 2, "plains");
  const lifted = await settle(page);
  const snap = await page.evaluate(() => window.__dbgNature());
  results.areaLayering = {
    baselineHalf: half.census.grassVerts,
    plainsDoubled: lifted.census.grassVerts,
    full: base.census.grassVerts,
    snapshot: { baseline: snap.baseline.grass, areas: snap.areas },
  };
  check(
    half.census.grassVerts < base.census.grassVerts * 0.85,
    `a 0.5 baseline barely thinned the sward (${half.census.grassVerts} against ` +
      `${base.census.grassVerts})`,
  );
  check(
    lifted.census.grassVerts > half.census.grassVerts,
    "plains x2 on a 0.5 baseline grew nothing back — the area is not layered on " + "the baseline",
  );
  check(
    lifted.census.grassVerts <= base.census.grassVerts * 1.05,
    "plains x2 on a 0.5 baseline overshot the full baseline — the area is " +
      "replacing the baseline rather than multiplying it",
  );
  check(
    snap.baseline.grass === 0.5 && snap.areas["plains.grass"] === 2,
    `the table did not store the pair: ${JSON.stringify(snap)}`,
  );
}

// ---------- the URL says the same thing before the first chunk is built -----
{
  const url = await openGame("&nature=trees:0");
  const off = await settle(url);
  results.urlOverride = {
    census: off.census,
    isDefault: off.isDefault,
    values: off.baseline,
  };
  check(off.baseline.trees === 0, "?nature=trees:0 did not reach the table");
  check(off.isDefault === false, "a URL override still reports the default world");
  check(
    off.census.propVerts < base.census.propVerts * 0.6,
    `?nature=trees:0 built ${off.census.propVerts} prop vertices against a ` +
      `baseline of ${base.census.propVerts}`,
  );
  await url.close();
}

console.log(JSON.stringify(results, null, 2));
if (fails.length) {
  console.error(`\nFAIL (${fails.length})`);
  for (const f of fails) {
    console.error(`  - ${f}`);
  }
}
await browser.close();
process.exit(fails.length ? 1 : 0);
