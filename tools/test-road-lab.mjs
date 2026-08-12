// THE ROAD SANDBOX, SWEPT — every case, in one load, with no world.
//
// `tools/test-road.mjs` measures the same two things on the streamed world, and
// it is slow and partial for reasons that are nobody's fault: it waits for
// chunks, it can only judge the 71% of the network that happens to be built,
// and whether a case exists at all is up to the seed. There is exactly one
// road at 45 degrees to the voxel grid in that world, and finding it took a
// screenshot from a person.
//
// `src/lab/road-stage.ts` builds the cases that break instead — an angled run,
// an axis-aligned control beside it, a hillside, a bend, a bridge, a fork, a
// merged crossroads and the narrow profile — on REAL voxel ground with the real
// carve and the game's own mesher and ribbon builder. Nothing streams, so every
// column is judgeable and the whole set is one page load.
//
// TWO NUMBERS, AND BOTH DIRECTIONS. That pairing is the point of this file:
//
//   poke   — ground drawn ABOVE the ribbon. The green cube on the road.
//   buried — the ribbon drawn ABOVE the walking surface. The hero standing IN
//            the road. These trade against each other — the fix for one is the
//            cause of the other — so a guard that holds only one of them will
//            happily watch you swap a visible defect for an unwalkable one,
//            which is exactly what happened before this file existed.
//
//   bun tools/test-road-lab.mjs
import { launchBrowser, newPage, wait, logPageErrors } from "./browser.mjs";
import { BASE as HOST } from "./target.mjs";

/** Every name the ground is drawn under. See the note in test-road.mjs. */
const GROUND_SRC = "^(road:|terrain:|chunk:terrain)";

/**
 * The budget per case, measured. A case is allowed a few samples at the
 * outermost sliver of its verge — three surfaces (a smooth ribbon, a stepped
 * shoulder and cube ground) cannot all agree there — and nothing approaching a
 * whole cube anywhere.
 */
/**
 * GROUND THROUGH THE GRAVEL IS ALSO AN OPEN DEFECT, and its ceiling says where.
 *
 *     axis    0 of 3840             angle  41 of 3600   worst 0.972
 *     slope  16 of 4080  worst 0.071   bend  1  worst 0.966
 *     bridge  0            cross 0      foot 4 worst 0.449   fork 10 worst 0.528
 *
 * `axis` and `angle` are the same road turned 45 degrees into the voxel grid,
 * and only the second has it — the carve is sampled at a column's CENTRE and
 * applied to the whole cell, so on a diagonal it is a CORNER that reaches into
 * the corridor, where the surface drawn over it is lower.
 *
 * TWO FIXES WERE BUILT AND BOTH ARE WORSE THAN THE DEFECT. Clipping the column
 * to the exact corridor surface takes `angle` to 0 and tears black holes along
 * every verge: the mesher builds a side face from the height DIFFERENCE between
 * neighbours and its quads assume whole units. Clipping to a WHOLE unit draws
 * correctly and puts a 1.0 step on the carriageway where a clipped cell meets
 * an unclipped one, against a `MAX_STEP_UP` of 0.5 — a wall in the middle of
 * the surface the corridor exists to make walkable. A cube corner is a worse
 * picture; a hole and a wall are worse games.
 *
 * What is left to try is on the drawing side: a shoulder quantised to the cell
 * a column occupies, so the corner and the centre resolve to the same integer.
 */
const MAX_WORST = 1.0;
const MAX_SAMPLES = 45;
/**
 * BURIAL IS AN OPEN DEFECT AND THIS IS ITS CEILING, NOT ITS TARGET.
 *
 * `poke` is 0 on every case here — the ground no longer stands through the
 * gravel anywhere in the sandbox. The other direction is not fixed: the ribbon
 * is drawn above the walking surface at the verge, and the sandbox is what
 * finally says how much and where.
 *
 *     axis   129 of 3840   worst 0.525
 *     angle  171 of 3600   worst 1.015
 *     slope  171 of 4080   worst 0.972
 *     bend / bridge / fork / cross / foot   under the budget
 *
 * The pairing is the finding. `axis` is the control and `angle` is the same
 * road turned 45 degrees into the voxel grid, and it is twice as bad — so the
 * cause is the grid, exactly as reported. It is the same three-way tension the
 * whole system has: a smooth ribbon, a shoulder that steps by whole units and
 * ground made of cubes, of which any two can be made to agree. The fix is
 * either a shoulder quantised to the cell a column occupies, or a walking
 * surface that follows the ribbon out to the rim instead of rounding.
 *
 * Held at the measured worst so it cannot grow while that is decided, and NOT
 * at zero, because a red probe on the roster is a probe people learn to ignore.
 */
const MAX_BURIED_WORST = 1.1;
const MAX_BURIED_SAMPLES = 200;

const browser = await launchBrowser();
const page = await newPage(browser, { width: 900, height: 600 });
logPageErrors(page);
await page.goto(`${HOST}/lab.html?road=all&t=1`, { waitUntil: "load" });
await page.waitForSelector("canvas");
await wait(2500);

const plan = await page.evaluate(() => window.__dbgRoadLab());

const results = [];
for (const c of plan.cases) {
  // ONE CASE PER EVALUATE. At cube resolution a case is a few thousand
  // raycasts, and the whole set in one call exceeds puppeteer's CDP
  // `protocolTimeout` and comes back as a protocol error that reads like a
  // crash rather than a result.
  const r = await page.evaluate(
    (caseId, groundSrc) => {
      const GROUND = new RegExp(groundSrc);
      const lab = window.__dbgRoadLab();
      const roadCase = lab.cases.find((q) => q.id === caseId);
      const out = {
        id: caseId,
        sampled: 0,
        poke: 0,
        worstPoke: 0,
        pokeAt: null,
        buried: 0,
        worstBuried: 0,
        buriedAt: null,
        step: 0,
        stepAt: null,
      };
      if (!roadCase) {
        return out;
      }
      // THE ENDS ARE NOT PART OF THE CASE. A road in the world stops inside a
      // settlement, on ground that settlement has already levelled to the deck;
      // one in here stops in open country, so its terminal plane is a cliff by
      // construction and every reading within a corridor's width of it is about
      // that cliff rather than about the case. Measured, sweeping the ends put
      // the `bridge` case's step at 8.9 — the bank at its abutment. Six units in
      // from each end is a little over one corridor half-width.
      const SKIP_ENDS = 6;
      for (const road of roadCase.roads) {
        const E = road.deckEdge;
        const p = road.pts;
        let total = 0;
        for (let i = 1; i < p.length; i++) {
          total += Math.hypot(p[i].x - p[i - 1].x, p[i].z - p[i - 1].z);
        }
        let travelled = 0;
        for (let i = 1; i < p.length; i++) {
          const a = p[i - 1];
          const b = p[i];
          let tx = b.x - a.x;
          let tz = b.z - a.z;
          const L = Math.hypot(tx, tz) || 1;
          tx /= L;
          tz /= L;
          const segStart = travelled;
          travelled += L;
          if (segStart < SKIP_ENDS || travelled > total - SKIP_ENDS) {
            continue;
          }
          // CUBE RESOLUTION: a terrain cell is 1x1, and a sweep coarser than that
          // steps over the single cube corner this whole stage exists to catch.
          for (let s = 0; s < L; s += 0.5) {
            for (let d = -(E - 0.05); d <= E - 0.05; d += 0.25) {
              const x = a.x + tx * s - tz * d;
              const z = a.z + tz * s + tx * d;
              const hit = window.__dbgRoadSurf(x, z, 2);
              const deck = hit.hits.find((q) => q.name.startsWith("road:"));
              if (!deck) {
                continue;
              }
              out.sampled++;
              // GROUND OVER THE RIBBON.
              const top = hit.hit || "";
              if (GROUND.test(top) && !top.startsWith("road:")) {
                const by = hit.surface - deck.y;
                if (by > 0) {
                  out.poke++;
                  if (by > out.worstPoke) {
                    out.worstPoke = by;
                    out.pokeAt = { x: +x.toFixed(1), z: +z.toFixed(1), by: +by.toFixed(3) };
                  }
                }
              }
              // AND THE RIBBON OVER THE HERO. `hit.ground` is `getHeight`, which
              // the raycast already carries.
              const sunk = deck.y - hit.ground;
              if (sunk > 0.2) {
                out.buried++;
              }
              if (sunk > out.worstBuried) {
                out.worstBuried = sunk;
                out.buriedAt = { x: +x.toFixed(1), z: +z.toFixed(1), by: +sunk.toFixed(3) };
              }
            }
          }
          // ...and can it be walked. Down the flat part only, which is what
          // `MAX_STEP_UP` is about — the shoulder at the very rim is a kerb.
          const half = Math.min(2.6, E * 0.52);
          for (let s = 0; s < L; s += 0.25) {
            for (let d = -half; d <= half; d += 0.5) {
              const x = a.x + tx * s - tz * d;
              const z = a.z + tz * s + tx * d;
              const g0 = window.__dbgRoadWorld(x, z).ground;
              const g1 = window.__dbgRoadWorld(x + 0.25, z).ground;
              const g2 = window.__dbgRoadWorld(x, z + 0.25).ground;
              const st = Math.max(Math.abs(g1 - g0), Math.abs(g2 - g0));
              if (st > out.step) {
                out.step = st;
                out.stepAt = { x: +x.toFixed(2), z: +z.toFixed(2) };
              }
            }
          }
        }
      }
      out.worstPoke = +out.worstPoke.toFixed(3);
      out.worstBuried = +out.worstBuried.toFixed(3);
      out.step = +out.step.toFixed(3);
      return out;
    },
    c.id,
    GROUND_SRC,
  );
  results.push(r);
}

console.log(JSON.stringify({ cross: plan.cross, cases: results }, null, 2));
await browser.close();

const fail = [];
if (results.length !== 9) {
  fail.push(`the sandbox built ${results.length} cases, expected 9`);
}
// A CROSSROADS THAT QUIETLY CAME BACK AS TWO ROADS tests nothing, and the merge
// refuses for four different good reasons — so the refusal is asserted, not
// hoped for.
if (plan.cross.nodes.length !== 1) {
  fail.push(
    `the crossing case made ${plan.cross.nodes.length} junctions: ` +
      (plan.cross.refused.join("; ") || "no reason given"),
  );
}
for (const r of results) {
  if (r.sampled === 0) {
    fail.push(`${r.id}: nothing was sampled — the case built no ribbon`);
    continue;
  }
  if (r.worstPoke >= MAX_WORST || r.poke > MAX_SAMPLES) {
    fail.push(
      `${r.id}: ${r.poke} of ${r.sampled} columns have ground drawn over the ` +
        `ribbon, worst ${r.worstPoke} at ${JSON.stringify(r.pokeAt)}`,
    );
  }
  if (r.worstBuried >= MAX_BURIED_WORST || r.buried > MAX_BURIED_SAMPLES) {
    fail.push(
      `${r.id}: ${r.buried} of ${r.sampled} columns have the ribbon drawn ABOVE ` +
        `the walking surface, worst ${r.worstBuried} at ${JSON.stringify(r.buriedAt)} — ` +
        "an actor standing there is inside the road",
    );
  }
  if (r.step >= 0.5) {
    fail.push(
      `${r.id}: the walking surface steps ${r.step} on the carriageway at ` +
        `${JSON.stringify(r.stepAt)}, against MAX_STEP_UP 0.5`,
    );
  }
}

if (fail.length > 0) {
  console.error("FAIL\n  " + fail.join("\n  "));
  process.exit(1);
}
console.error("PASS");
