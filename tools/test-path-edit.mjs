// AUTHORING A PATH WHILE THE WORLD IS RUNNING — issue #142 §12.
//
// Everything about this world is planned before the first chunk exists, on
// purpose: `planSettlements` routes and carves BEFORE `terrain.roads` is set,
// so no chunk carrying a corridor is ever built while roads are being planned.
// `World.addPath` is the one hole in that, and this is what stands behind it.
//
// FIVE THINGS, and the third is the one that matters.
//
//   graph  — the network gained exactly one edge, built to the profile that was
//            asked for, and it is DRAWN: a path the placers can see but the
//            player cannot is the same class of bug as the sky island's
//            `NO_ROADS`, just the other way round.
//   refuse — a refusal is REPORTED (§12f). An unknown profile name and two ends
//            on top of each other both come back with a reason. The first user
//            of an editor that silently does nothing concludes it is broken.
//   poke   — the cross-section over the NEW edge, rim to rim: is anything drawn
//            ABOVE the ribbon? This is issue #15's own measurement pointed at a
//            corridor that did not exist when the world was built, and it is
//            the whole safety net for the feature. An editor that can author a
//            path can author one that reopens #15, and the carve, the walking
//            surface and the ribbon all have to agree about a corridor cut into
//            terrain that was already meshed.
//   ground — the hero is not left INSIDE the ground. `getHeight` used to be a
//            pure function of the seed; carving under someone standing still is
//            the first thing in this game that makes it not one. The carve
//            raises as well as lowers (`profileRoad` fills dips), so this is a
//            real hazard and not a formality — see `refitHero` in main.ts.
//   walk   — and the deck is walkable: no step over MAX_STEP_UP along it.
//
// Exits non-zero on any of them.
//
//   bun tools/test-path-edit.mjs
import { launchBrowser, newPage, wait, logPageErrors } from './browser.mjs';
import { BASE as HOST } from './target.mjs';

const browser = await launchBrowser();
const page = await newPage(browser, { width: 900, height: 600 });
logPageErrors(page);
await page.goto(`${HOST}/?fps=30&menu=0&fs=0&enemies=0&beasts=0`, { waitUntil: 'load' });
await page.waitForSelector('canvas');
await wait(5000);

// -- the refusals, before anything is built ---------------------------------
const refusals = await page.evaluate(() => {
  const p = window.__dbgPlayerPos();
  return {
    unknownProfile: window.__dbgAddPath(p.x, p.z, p.x + 60, p.z + 40, 'cobblestone'),
    tooShort: window.__dbgAddPath(p.x, p.z, p.x + 3, p.z + 1, 'footpath'),
    // INTO THE WATER. On seed 1337 this bearing runs down to the shore and
    // ends on the waterline; a footpath cannot bridge, so `profileRoad` would
    // floor its wet samples 1.9 above the surface and hand back a deck with
    // nothing under it and no piers to put there. See `World.addPath`.
    intoWater: window.__dbgAddPath(p.x, p.z, p.x + 78, p.z + 46, 'footpath'),
  };
});

// -- author one --------------------------------------------------------------
const built = await page.evaluate(() => {
  const p = window.__dbgPlayerPos();
  // BOTH counts read BEFORE the call. `drawnBefore` used to be read in the
  // return literal, which is evaluated after `__dbgAddPath` has already run —
  // so it reported the new total and the "went 3 -> 3" failure was the probe
  // describing its own ordering.
  const pathsBefore = window.__dbgPaths().paths.length;
  const drawnBefore = window.__dbgTowns().roads.length;
  // INLAND AND UPHILL, and chosen by measurement rather than taste: this
  // bearing's lowest ground over its whole run is 12 against a waterline of 8,
  // so the route has no reason to bridge and no chance to.
  const r = window.__dbgAddPath(p.x, p.z, p.x + 60, p.z - 40, 'footpath');
  return { result: r, pathsBefore, drawnBefore, heroBefore: { x: p.x, y: p.y, z: p.z } };
});

// The rebuild drops every chunk and the streamer refills them on its own
// budget; the cross-section sweep raycasts real geometry, so it has to wait for
// the corridor to be back in the scene.
await wait(6000);

const out = await page.evaluate((made) => {
  const paths = window.__dbgPaths().paths;
  const added = paths.find((q) => q.id === made.result.id) ?? null;
  const drawn = window.__dbgTowns().roads;
  const edge = drawn.find((r) => r.id === made.result.id) ?? null;

  // -- the cross-section over the new edge, rim to rim --------------------
  const poke = { sampled: 0, over: 0, worst: 0, at: null };
  let step = 0;
  let stepAt = null;
  if (edge) {
    const p = edge.path;
    const DECK_EDGE = edge.deckEdge;
    const half = Math.min(2.6, DECK_EDGE * 0.52);
    const h = (x, z) => window.__dbgWorld(x, z).ground;
    for (let i = 1; i < p.length / 3; i++) {
      const ax = p[(i - 1) * 3];
      const az = p[(i - 1) * 3 + 2];
      const bx = p[i * 3];
      const bz = p[i * 3 + 2];
      let tx = bx - ax;
      let tz = bz - az;
      const L = Math.hypot(tx, tz) || 1;
      tx /= L; tz /= L;
      for (let s = 0; s < L; s += 1.5) {
        const cx = ax + tx * s;
        const cz = az + tz * s;
        for (let d = -(DECK_EDGE - 0.2); d <= DECK_EDGE - 0.2; d += 0.6) {
          const x = cx - tz * d;
          const z = cz + tx * d;
          const hit = window.__dbgSurfaceY(x, z, 2);
          if (!hit.hits.some((q) => /^road:/.test(q.name))) continue;
          poke.sampled++;
          if (!/^terrain:/.test(hit.hit || '')) continue;
          const road = hit.hits.find((q) => /^road:/.test(q.name));
          const by = hit.surface - road.y;
          if (by <= 0) continue;
          poke.over++;
          if (by > poke.worst) {
            poke.worst = by;
            poke.at = { x: +x.toFixed(1), z: +z.toFixed(1), fromCentre: +d.toFixed(1) };
          }
        }
      }
      // ...and the walking surface along it, at the router's own pitch.
      for (let s = 0; s < L; s += 0.25) {
        const a = h(ax + tx * s, az + tz * s);
        const b = h(ax + tx * (s + 0.25), az + tz * (s + 0.25));
        if (Math.abs(b - a) > step) {
          step = Math.abs(b - a);
          stepAt = { x: +(ax + tx * s).toFixed(2), z: +(az + tz * s).toFixed(2) };
        }
      }
      // A wide corridor with a whole polyline is a lot of raycasts; the sweep
      // above is already the expensive half, so the band is left coarse.
      void half;
    }
  }

  const p = window.__dbgPlayerPos();
  const g = window.__dbgWorld(p.x, p.z).ground;
  return {
    added,
    drawnCount: drawn.length,
    edgeIsDrawn: edge !== null,
    crossSection: {
      sampled: poke.sampled,
      terrainOverRibbon: poke.over,
      worstPoke: +poke.worst.toFixed(3),
      at: poke.at,
      clean: poke.over === 0,
    },
    carriageway: {
      worstStepOver025: +step.toFixed(3),
      at: stepAt,
      maxStepUp: 0.5,
      walkable: step < 0.5,
    },
    hero: {
      y: +p.y.toFixed(3),
      ground: +g.toFixed(3),
      // Positive is standing on or above it; negative is buried.
      clearance: +(p.y - g).toFixed(3),
    },
  };
}, built);

console.log(JSON.stringify({ refusals, built, ...out }, null, 2));
await browser.close();

const fail = [];
if (!refusals.unknownProfile.error) {
  fail.push('an unknown profile name was accepted instead of reported');
}
if (!refusals.tooShort.error) {
  fail.push('a path with both ends in the same place was accepted');
}
if (!refusals.intoWater.error) {
  fail.push('a footpath was routed into the water instead of being refused — '
    + 'it cannot bridge, so the deck would stand 1.9 over the surface on nothing');
}
if (built.result.error) {
  fail.push(`the path was refused: ${built.result.error}`);
} else {
  if (out.added === null) fail.push('the network did not gain the edge');
  else if (out.added.profile !== 'path:footpath') {
    fail.push(`the edge was built to ${out.added.profile}, not the profile asked for`);
  }
  if (out.drawnCount !== built.drawnBefore + 1) {
    fail.push(`drawn paths went ${built.drawnBefore} -> ${out.drawnCount}, expected one more`);
  }
  if (!out.edgeIsDrawn) fail.push('the new edge is on the network but is not drawn');
  if (out.crossSection.sampled === 0) {
    fail.push('the cross-section sweep found no ribbon over the new edge at all');
  }
  if (!out.crossSection.clean) {
    fail.push(`${out.crossSection.terrainOverRibbon} of ${out.crossSection.sampled} `
      + 'cross-section samples over the AUTHORED path have terrain drawn over the '
      + `ribbon (issue #15), worst ${out.crossSection.worstPoke}`);
  }
  if (!out.carriageway.walkable) {
    fail.push(`the authored deck steps ${out.carriageway.worstStepOver025}, `
      + 'against MAX_STEP_UP 0.5');
  }
}
// -0.05 and not 0: the hero rests a hair into the surface he stands on, and the
// failure this guards against is a whole carve depth (up to 1.62), not a
// rounding error.
if (out.hero.clearance < -0.05) {
  fail.push(`the hero was left ${(-out.hero.clearance).toFixed(2)} inside the ground `
    + 'after the carve — see refitHero in main.ts');
}

if (fail.length > 0) {
  console.error('FAIL\n  ' + fail.join('\n  '));
  process.exit(1);
}
console.error('PASS');
