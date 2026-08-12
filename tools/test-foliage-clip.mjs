// Verifies that no foliage grows through a building — issue #131.
//
// Usage: bun tools/test-foliage-clip.mjs        (dev server must be up)
//
// THE MEASUREMENT IS TAKEN OFF THE DRAWN VERTICES, not off the placer. The rule
// itself (`SiteClearance`, src/core/types.ts) reasons about a prop as a disc of
// its measured extent, so asking the placer whether it obeyed its own disc
// proves only that the arithmetic runs. What the issue is a photograph of is a
// blade of grass standing inside a palisade plank, so what `__dbgFoliageClip`
// counts is vertices of the two chunk prop meshes that land inside the
// settlement's own timber.
//
// BOTH HALVES, and the second one is the point:
//
//   * NOTHING CLIPS — no vertex of the grass or prop mesh is inside a collider,
//     at any settlement;
//   * ...AND THE FOLIAGE STILL TOUCHES — hundreds of vertices stand within half
//     a unit of the timber without being in it. A rule that emptied a disc
//     around every town would pass the first half perfectly and is exactly what
//     the issue says it does NOT want ("foliage is allowed very close to
//     structures as long as they don't clip"), so the second half is what stops
//     the fix from being a clearance radius in disguise.
//
// The `snug` floor is asserted over the WORLD rather than per settlement, and
// deliberately: how much sward a given layout leaves is a tuning decision (a
// camp's ground is trampled bare by design — `trodden`, world/props.ts), and
// Redbriar's yard has been bare since long before this rule existed. What must
// not happen is every settlement going bare, and that is a total.
import { launchBrowser, newPage } from "./browser.mjs";
import { BASE as HOST, NO_WARMUP } from "./target.mjs";

/**
 * Foliage vertices that must stand within `GAP` of built timber, world-wide.
 *
 * A few hundred is one wall's worth of sward. The floor is not a target — it is
 * the difference between "grass grows against the buildings" and "a disc was
 * cleared around them", which is the distinction issue #131 turns on.
 */
const MIN_SNUG = 200;
/** How near timber a vertex has to be to count as touching it. */
const GAP = 0.5;

const fails = [];
const out = { towns: [], skipped: [] };
let snug = 0;

const browser = await launchBrowser();
const page = await newPage(browser, { width: 1280, height: 800 });
await page.goto(`${HOST}/?menu=0&vol=0&fs=0&${NO_WARMUP}`, { waitUntil: "load" });
await page.waitForSelector("canvas");
await page.waitForFunction(() => window.__dbgBoot?.().playing, { timeout: 30000 });

const towns = await page.evaluate(() => window.__dbgTowns().structures.perTown);
if (!towns.length) {
  fails.push("the world built no settlements to check");
}

for (const town of towns) {
  // A CARRIED town rides a moving piece of world and grows no chunk foliage at
  // all — there is nothing there for it to clip, and teleporting to the ground
  // column under it would measure the wilderness it happens to be flying over.
  if (town.carried) {
    out.skipped.push(town.id);
    continue;
  }

  // Stand in it and let the ring fill: the meshes this reads are the streamed
  // ones, so a reading taken before they arrive is a reading of nothing.
  //
  // LATCHED, and it has to be. `streaming === false` is already true the
  // instant the teleport lands — the streamer has not noticed yet — so the
  // plain wait returns immediately and measures the chunks around the PREVIOUS
  // town. That is exactly what it did: redbriar came back with 4160 vertices
  // asked on its own and 0 asked after a hop from the Encampment. So the wait
  // is for the ring to start filling and then finish.
  await page.evaluate((t) => {
    window.__streamSeen = false;
    window.__dbgTp(t.x, t.z);
  }, town);
  await page.waitForFunction(
    () => {
      const busy = window.__dbgZone().streaming;
      if (busy) {
        window.__streamSeen = true;
      }
      return window.__streamSeen && !busy;
    },
    { polling: "raf", timeout: 60000 },
  );

  const clip = await page.evaluate(
    (t, rr, g) => window.__dbgFoliageClip(t.x, t.z, rr, g),
    town,
    town.radius + 6,
    GAP,
  );

  if (clip.verts === 0) {
    fails.push(
      `${town.id}: no foliage streamed within ${clip.radius} units — nothing was measured`,
    );
  }
  if (town.boxes === 0) {
    fails.push(`${town.id}: the settlement grew no colliders — nothing to clip`);
  }
  if (clip.hits > 0) {
    fails.push(
      `${town.id}: ${clip.hits} foliage vertices inside a structure, ` +
        `first at ${clip.at.x},${clip.at.y},${clip.at.z}`,
    );
  }

  snug += clip.snug;
  out.towns.push({
    id: town.id,
    radius: town.radius,
    colliders: town.boxes,
    vertsChecked: clip.verts,
    clipping: clip.hits,
    touching: clip.snug,
  });
}

if (snug < MIN_SNUG) {
  fails.push(
    `only ${snug} foliage vertices in the world stand within ${GAP} of a ` +
      "building: the foliage is being held off the structures rather than kept out " +
      "of them, which is the clearance-disc failure issue #131 asks not to have",
  );
}
out.touchingTotal = snug;

out.pass = fails.length === 0;
if (fails.length) {
  out.failures = fails;
}
console.log(JSON.stringify(out, null, 2));
await page.close();
await browser.close();
process.exit(fails.length ? 1 : 0);
