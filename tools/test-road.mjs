// The road guard: is the road you SEE the road you STAND ON?
//
// Every other probe in here compares the world against itself — the player
// against `getHeight`, a collider against a mesh's own footprint — and none of
// them can see the failure this one exists for: the hero exactly where the
// physics puts him, and buried to the chest, because the ribbon in front of him
// was drawn above his feet. `__dbgSurfaceY` raycasts the actual scene just over
// the walking surface and reports what is there, which is the only way to ask.
//
// FOUR NUMBERS, and they fail for different reasons.
//
//   sink  — how far the drawn surface floats over the walking surface, sampled
//           along every carriageway. Anything past ~0.2 is visible on a figure
//           1.8 units tall. Before the ribbon was made to sample the surface it
//           was 1.66 at the spawn; it is 0.036 across the whole network now.
//   step  — the largest jump in the WALKING surface between neighbours a
//           quarter unit apart, on the carriageway. MAX_STEP_UP is 0.5, so
//           anything at or over that is a wall the hero cannot cross and cannot
//           see. This was a KNOWN failure at the fork — 0.801, where three
//           carriageways overlapped and `surfaceAt` answered with the nearest
//           road's deck, which jumps between two values across the line
//           equidistant from them. Fixed by making the fork three roads instead
//           of one (`AVOID_R` in roads.ts) and holding all three decks level
//           across it (`JUNCTION_HOLD` in towns.ts): 0.047.
//   poke  — the CROSS-SECTION question, which the two above cannot ask because
//           they only ever sample the centreline: is anything drawn ABOVE the
//           ribbon between its rims? Terrain here is grass standing up through
//           the gravel — issue #15's "ground clipping through on to the road",
//           and 5 samples' worth of it before the carve's shoulder ramp and the
//           walking surface's were tied to one number (`SHOULDER_IN`).
//   furn  — where the lamps and fingerposts ended up: the smallest gap between
//           any two, and how near a centreline the nearest one comes. Under
//           DECK_EDGE (5.0) is standing ON the road. Both were reported in
//           issue #15 and neither had a number attached to it before.
//
//   bun tools/test-road.mjs
import { launchBrowser, newPage, wait, logPageErrors } from './browser.mjs';

const browser = await launchBrowser();
const page = await newPage(browser, { width: 900, height: 600 });
logPageErrors(page);
await page.goto('http://localhost:5187/?fps=30&menu=0', { waitUntil: 'load' });
await page.waitForSelector('canvas');
await wait(5000);   // the corridor has to be streamed before it can be hit

const out = await page.evaluate(() => {
  const towns = window.__dbgTowns();

  // -- what is drawn, against what is walked on ----------------------------
  const roads = towns.roads.map((r) => {
    const p = r.path;
    let worst = 0;
    let at = null;
    let over = 0;
    let tested = 0;
    for (let i = 1; i < p.length / 3; i++) {
      const ax = p[(i - 1) * 3], az = p[(i - 1) * 3 + 2];
      const bx = p[i * 3], bz = p[i * 3 + 2];
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az)));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const x = ax + (bx - ax) * t;
        const z = az + (bz - az) * t;
        const s = window.__dbgSurfaceY(x, z);
        // Only the ground surfaces answer this question; a bush overhead is not
        // something the hero is buried in. Both are named for exactly this.
        if (!s.hit || !/^(road:|terrain:)/.test(s.hit)) continue;
        tested++;
        if (s.sink > 0.2) over++;
        if (s.sink > worst) {
          worst = s.sink;
          at = { x: +x.toFixed(1), z: +z.toFixed(1), drawn: s.surface, walked: s.ground, by: s.hit };
        }
      }
    }
    return { id: r.id, tested, worstSink: +worst.toFixed(3), over20cm: over, at };
  });

  // -- steps in the walking surface, on the carriageway only ---------------
  const segs = [];
  for (const r of towns.roads) {
    const p = r.path;
    for (let i = 1; i < p.length / 3; i++) {
      segs.push([p[(i - 1) * 3], p[(i - 1) * 3 + 2], p[i * 3], p[i * 3 + 2]]);
    }
  }
  const onRoad = (x, z) => {
    for (const [ax, az, bx, bz] of segs) {
      const dx = bx - ax, dz = bz - az;
      const L = dx * dx + dz * dz || 1;
      let u = ((x - ax) * dx + (z - az) * dz) / L;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      if (Math.hypot(x - (ax + dx * u), z - (az + dz * u)) <= 2.6) return true;
    }
    return false;
  };
  const h = (x, z) => window.__dbgWorld(x, z).ground;
  const S = 0.25;
  let step = 0;
  let stepAt = null;
  // The fork, which is the only place carriageways overlap.
  for (let x = 87; x <= 123; x += S) {
    for (let z = -24; z <= 12; z += S) {
      if (!onRoad(x, z)) continue;
      const a = h(x, z);
      for (const [dx, dz] of [[S, 0], [0, S]]) {
        if (!onRoad(x + dx, z + dz)) continue;
        const d = Math.abs(h(x + dx, z + dz) - a);
        if (d > step) { step = d; stepAt = { x: +x.toFixed(2), z: +z.toFixed(2) }; }
      }
    }
  }

  // -- what is drawn ACROSS the carriageway, rim to rim --------------------
  //
  // The two passes above walk the centreline, so neither can see a shoulder
  // standing up through the verge — the ribbon is 10 units wide and they sample
  // a line down the middle of it. This sweeps the section instead, and the
  // question is simply: between the rims, is the topmost thing the road?
  //
  // Terrain is the failure. Anything else overhead is a prop or a building and
  // is somebody else's problem — a barrel at the roadside is not a road bug —
  // so only `terrain:` counts, and only where a ribbon is actually drawn (a
  // town's interior is route, not carriageway, and its yard is meant to show).
  const DECK_EDGE = 5.0;
  const poke = { sampled: 0, over: 0, worst: 0, at: null };
  for (const r of towns.roads) {
    const p = r.path;
    for (let i = 1; i < p.length / 3; i++) {
      const ax = p[(i - 1) * 3], az = p[(i - 1) * 3 + 2];
      const bx = p[i * 3], bz = p[i * 3 + 2];
      let tx = bx - ax, tz = bz - az;
      const L = Math.hypot(tx, tz) || 1;
      tx /= L; tz /= L;
      for (let s = 0; s < L; s += 1.5) {
        const cx = ax + tx * s, cz = az + tz * s;
        for (let d = -(DECK_EDGE - 0.2); d <= DECK_EDGE - 0.2; d += 0.6) {
          const x = cx - tz * d, z = cz + tx * d;
          const hit = window.__dbgSurfaceY(x, z, 2);
          // Only where the road is the thing being drawn at all: no ribbon, no
          // claim. `hits` is top-down, so a road anywhere below the top hit
          // means something is over it.
          if (!hit.hits.some((q) => /^road:/.test(q.name))) continue;
          poke.sampled++;
          if (!/^terrain:/.test(hit.hit || '')) continue;
          const road = hit.hits.find((q) => /^road:/.test(q.name));
          const by = hit.surface - road.y;
          if (by <= 0) continue;
          poke.over++;
          if (by > poke.worst) {
            poke.worst = by;
            poke.at = {
              x: +x.toFixed(1), z: +z.toFixed(1), fromCentre: +d.toFixed(1),
              terrain: hit.surface, ribbon: road.y, road: r.id,
            };
          }
        }
      }
    }
  }

  // -- the lamps and the fingerposts ---------------------------------------
  const f = window.__dbgTowns().furniture;

  return {
    ribbon: roads,
    carriageway: {
      worstStepOver025: +step.toFixed(3),
      at: stepAt,
      maxStepUp: 0.5,
      walkable: step < 0.5,
    },
    crossSection: {
      sampled: poke.sampled,
      terrainOverRibbon: poke.over,
      worstPoke: +poke.worst.toFixed(3),
      at: poke.at,
      clean: poke.over === 0,
    },
    furniture: f,
  };
});

console.log(JSON.stringify(out, null, 2));
await browser.close();
