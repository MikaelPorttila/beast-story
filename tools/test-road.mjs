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
//
//           SWEPT ALONG EVERY EDGE, not over a window. It used to scan a fixed
//           box - x 87..123, z -24..12 on seed 1337 - which is the fork and
//           nothing else, so a road anywhere but there was unguarded and a NEW
//           kind of path would have been born untested (issue #142, section 4).
//           It now marches each deck polyline and samples a band across it,
//           which covers the fork the same way and everything else as well.
//   poke  — the CROSS-SECTION question, which the two above cannot ask because
//           they only ever sample the centreline: is anything drawn ABOVE the
//           ribbon between its rims? Terrain here is grass standing up through
//           the gravel — issue #15's "ground clipping through on to the road",
//           and 5 samples' worth of it before the carve's shoulder ramp and the
//           walking surface's were tied to one number (`SHOULDER_IN`).
//   track — the settlements' beaten tracks, which are paths on the same network
//           since issue #142 and used to be a private array inside terrain.ts
//           that only the colour pass could read. Two things have to hold at
//           once and they pull opposite ways: a track must be VISIBLE to what
//           grows, so grass stops coming up through a camp's thoroughfare, and
//           INVISIBLE to what is built, because every track was derived from
//           where a hut, a tent or a fire already stands and one that pushed
//           them away would erase its own reason for existing.
//   furn  — where the lamps and fingerposts ended up: the smallest gap between
//           any two, and how near a centreline the nearest one comes. Under
//           the rim is standing ON the road. Both were reported in issue #15
//           and neither had a number attached to it before.
//
// Exits non-zero on any of them, so the suite can run it.
//
//   bun tools/test-road.mjs
import { launchBrowser, newPage, wait, logPageErrors } from './browser.mjs';
import { BASE as HOST } from './target.mjs';

// EVERY NAME THE GROUND IS DRAWN UNDER, and the list is a bug fix rather than
// tidiness. This file matched `/^terrain:/`, which is what `chunk.ts` names a
// terrain mesh — and `world/index.ts` RENAMES it to `chunk:terrain` on the way
// into the scene. So the cross-section assertion below has been matching
// nothing at all and reporting a clean 0 whatever the world looked like.
// Measured the moment the pattern was corrected: 77 samples of chunk terrain
// and 379 of the far clipmap standing over the ribbon, worst 0.682.
//
// `distant:` is in the list for the same reason it turned out to be the biggest
// offender: the HLOD is a coarse underlay sampled every 8-24 units, so it
// chords straight over a corridor the near ground has carved.
const GROUND_SRC = '^(road:|terrain:|chunk:terrain|distant:terrain)';

const browser = await launchBrowser();
const page = await newPage(browser, { width: 900, height: 600 });
logPageErrors(page);
await page.goto(`${HOST}/?fps=30&menu=0`, { waitUntil: 'load' });
await page.waitForSelector('canvas');
await wait(5000);   // the corridor has to be streamed before it can be hit

const out = await page.evaluate((groundSrc) => {
  // Built in the PAGE, because that is where this whole function runs — a
  // regex closed over from the tool's own scope is not defined here.
  const GROUND = new RegExp(groundSrc);
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
        if (!s.hit || !GROUND.test(s.hit)) continue;
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
  // Half the FLAT part of each path, which is what "on the carriageway" means:
  // 2.6 on the cart road, i.e. the number that used to be written in here once
  // for the whole world.
  const flatHalf = (r) => Math.min(2.6, r.deckEdge * 0.52);
  const segs = [];
  for (const r of towns.roads) {
    const p = r.path;
    const half = flatHalf(r);
    for (let i = 1; i < p.length / 3; i++) {
      segs.push([p[(i - 1) * 3], p[(i - 1) * 3 + 2], p[i * 3], p[i * 3 + 2], half]);
    }
  }
  // Asked of the WHOLE network, so a mixed-width one answers per path instead
  // of against one remembered half-width.
  const onRoad = (x, z) => {
    for (const [ax, az, bx, bz, half] of segs) {
      const dx = bx - ax, dz = bz - az;
      const L = dx * dx + dz * dz || 1;
      let u = ((x - ax) * dx + (z - az) * dz) / L;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      if (Math.hypot(x - (ax + dx * u), z - (az + dz * u)) <= half) return true;
    }
    return false;
  };
  const h = (x, z) => window.__dbgWorld(x, z).ground;
  const S = 0.25;
  let step = 0;
  let stepAt = null;
  let stepped = 0;
  // MARCHED ALONG EVERY EDGE. The neighbours are taken in +x and +z exactly as
  // the box scan took them, so the number means what it always meant; the
  // difference is only which columns get asked. The duplicated work where two
  // arms overlap at the fork is the point - that is where the failure was.
  for (const r of towns.roads) {
    const p = r.path;
    const half = flatHalf(r);
    for (let i = 1; i < p.length / 3; i++) {
      const ax = p[(i - 1) * 3], az = p[(i - 1) * 3 + 2];
      const bx = p[i * 3], bz = p[i * 3 + 2];
      let tx = bx - ax, tz = bz - az;
      const L = Math.hypot(tx, tz) || 1;
      tx /= L; tz /= L;
      for (let s = 0; s < L; s += S) {
        for (let d = -half; d <= half; d += S) {
          const x = ax + tx * s - tz * d;
          const z = az + tz * s + tx * d;
          if (!onRoad(x, z)) continue;
          const a = h(x, z);
          for (const [dx, dz] of [[S, 0], [0, S]]) {
            if (!onRoad(x + dx, z + dz)) continue;
            stepped++;
            const delta = Math.abs(h(x + dx, z + dz) - a);
            if (delta > step) {
              step = delta;
              stepAt = { x: +x.toFixed(2), z: +z.toFixed(2), road: r.id };
            }
          }
        }
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
  const poke = { sampled: 0, over: 0, worst: 0, at: null };
  for (const r of towns.roads) {
    // EACH PATH'S OWN RIM. 5.0 was hardcoded here, which was right for exactly
    // as long as every path in the world was a cart road (issue #142).
    const DECK_EDGE = r.deckEdge;
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
          if (!GROUND.test(hit.hit || '') || /^road:/.test(hit.hit || '')) continue;
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

  // -- what a path SHEDS ----------------------------------------------------
  //
  // Issue #142 asks for stones and sticks along a path, and §7 is right that it
  // is the corridor clearance read the other way. The shape is the assertion:
  // nothing down the middle of a carriageway (wheels sweep it), something at
  // the verge, nothing again past the rim. A rule that answered a flat value
  // everywhere would scatter gravel down the centre line and still pass a test
  // that only asked "is it non-zero somewhere".
  const litter = (() => {
    const bad = [];
    const bands = [];
    for (const r of window.__dbgTowns().roads) {
      const p = r.path;
      const i = Math.floor(p.length / 6) * 3;
      const cx = p[i];
      const cz = p[i + 2];
      let tx = p[i + 3] - cx;
      let tz = p[i + 5] - cz;
      const L = Math.hypot(tx, tz) || 1;
      tx /= L; tz /= L;
      const at = (d) => window.__dbgPaths(cx - tz * d, cz + tx * d).at.litter;
      const middle = at(0);
      const verge = Math.max(at(r.deckEdge * 0.8), at(r.deckEdge * 0.95), at(r.deckEdge));
      const beyond = at(r.deckEdge + 1.2);
      bands.push({ id: r.id, middle, verge, beyond });
      if (middle !== 0) bad.push(`${r.id}: ${middle} litter down the middle`);
      if (!(verge > 0)) bad.push(`${r.id}: nothing at the verge`);
      if (beyond !== 0) bad.push(`${r.id}: ${beyond} litter past the skirt`);
    }
    return { bands, failures: bad, pass: bad.length === 0 && bands.length > 0 };
  })();

  // -- the beaten tracks ---------------------------------------------------
  //
  // Sampled at the FAR end of each track, past the point where a road's own
  // terminal dome still reaches: a settlement's carriageway ends at its centre
  // and every track starts there, so a column near the middle is legitimately
  // inside the road as well and says nothing about the track.
  const tracks = (() => {
    const all = window.__dbgPaths().paths;
    const worn = all.filter((q) => q.profile === 'path:track');
    // The DRAWN paths with their full polylines, which `__dbgTowns` has and
    // `__dbgPaths` (which reports a path's ends) does not.
    const drawn = window.__dbgTowns().roads.map((r) => ({
      path: r.path, deckEdge: r.deckEdge,
    }));
    const bad = [];
    let tested = 0;
    let wornSamples = 0;
    for (const q of worn) {
      if (q.draw || q.surface || q.refusesBuilt) {
        bad.push(`${q.id} claims a role a beaten track must not have`);
        continue;
      }
      for (const t of [0.6, 0.75, 0.9]) {
        const x = q.x0 + (q.x1 - q.x0) * t;
        const z = q.z0 + (q.z1 - q.z0) * t;
        // Skip anywhere a DRAWN path could be answering instead — its rim plus
        // the track's own is the widest either query can reach back from.
        //
        // AGAINST THE POLYLINE, not against a chord between its ends: the
        // Stonewatch spur bends by tens of units over its length, and a track
        // laid along a road (every settlement has one, the way in) sits dead on
        // the carriageway for its whole run. Tested against the chord, those
        // columns read as clear of every road and the road's own `builtEdge`
        // of -4.99 got blamed on the track.
        const nearRoad = drawn.some((r) => {
          const half = r.deckEdge + q.deckEdge;
          for (let i = 3; i < r.path.length; i += 3) {
            const ax = r.path[i - 3];
            const az = r.path[i - 1];
            const dx = r.path[i] - ax;
            const dz = r.path[i + 2] - az;
            const L = dx * dx + dz * dz || 1;
            let u = ((x - ax) * dx + (z - az) * dz) / L;
            u = u < 0 ? 0 : u > 1 ? 1 : u;
            if (Math.hypot(x - (ax + dx * u), z - (az + dz * u)) < half) return true;
          }
          return false;
        });
        if (nearRoad) continue;
        tested++;
        const at = window.__dbgPaths(x, z).at;
        // VISIBLE TO FOLIAGE: on the centreline the column is a full rim inside.
        if (!(at.edge < 0)) {
          bad.push(`${q.id} at t=${t}: foliage cannot see it (edge ${at.edge})`);
        }
        // INVISIBLE TO WHAT IS BUILT.
        if (Number.isFinite(at.builtEdge) && at.builtEdge < 0) {
          bad.push(`${q.id} at t=${t}: refuses a built thing (builtEdge ${at.builtEdge})`);
        }
        // AND IT PAINTS. The colour field is the one thing a track does.
        if (at.wear > 0) wornSamples++;
        else bad.push(`${q.id} at t=${t}: wears nothing`);
      }
    }
    return {
      count: worn.length,
      drawn: drawn.length,
      sampled: tested,
      worn: wornSamples,
      failures: bad,
      pass: bad.length === 0 && worn.length > 0 && tested > 0,
    };
  })();

  // -- the lamps and the fingerposts ---------------------------------------
  const f = window.__dbgTowns().furniture;

  return {
    ribbon: roads,
    profiles: towns.roads.map((r) => ({
      id: r.id, profile: r.profile, deckEdge: r.deckEdge,
    })),
    carriageway: {
      /** Neighbour pairs tested, over every edge - not a window. */
      sampled: stepped,
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
      // A BUDGET AND A CEILING, not zero, and the zero it replaces was a
      // fiction: this counted hits whose mesh name starts `terrain:`, and
      // `world/index.ts` renames every terrain mesh to `chunk:terrain` on the
      // way into the scene — so it matched nothing and reported clean whatever
      // the world looked like. Corrected, seed 1337 had 191 of 5296 samples
      // with ground over the ribbon, worst 0.569.
      //
      // 0.2 is the threshold the `sink` pass above already uses, and for the
      // same reason: on a figure 1.8 units tall a fifth of a unit is visible
      // and a tenth is not. 12 samples at worst 0.146 survive, all of them a
      // rim vertex on the last 0.2 of a verge; the count is here so that
      // residue cannot quietly grow back into the 191.
      clean: poke.worst < 0.2 && poke.over <= 20,
    },
    litter,
    tracks,
    furniture: f,
  };
}, GROUND_SRC);

console.log(JSON.stringify(out, null, 2));
await browser.close();

// -- the assertions --------------------------------------------------------
//
// Every one of these was a shipped bug with a screenshot attached, and every
// one is a number the world either has or does not. This printed them and
// returned 0 whatever they said, so a regression was only caught by somebody
// reading the output.
const fail = [];
for (const r of out.ribbon) {
  // 0.2 is the threshold the sink pass already counts against: on a figure 1.8
  // units tall, a fifth of a unit of float is visible.
  if (r.over20cm > 0) {
    fail.push(`${r.id}: ${r.over20cm} samples with the ribbon over 0.2 off the `
      + `walking surface (worst ${r.worstSink})`);
  }
}
if (out.carriageway.sampled === 0) fail.push('the step sweep tested nothing');
if (!out.carriageway.walkable) {
  fail.push(`walking surface steps ${out.carriageway.worstStepOver025} on the `
    + 'carriageway, against MAX_STEP_UP 0.5');
}
if (out.crossSection.sampled === 0) fail.push('the cross-section sweep tested nothing');
if (!out.crossSection.clean) {
  fail.push(`${out.crossSection.terrainOverRibbon} of ${out.crossSection.sampled} `
    + 'cross-section samples have ground drawn over the ribbon (issue #15), '
    + `worst ${out.crossSection.worstPoke} — the budget is 20 samples under 0.2`);
}
if (!out.litter.pass) {
  fail.push(`path litter: ${out.litter.failures.join('; ') || 'no path answered at all'}`);
}
if (!out.tracks.pass) {
  fail.push(`beaten tracks: ${out.tracks.failures.join('; ') || 'none on the network'}`);
}
if (out.furniture.onCarriageway > 0) {
  fail.push(`${out.furniture.onCarriageway} pieces of road furniture stand on a `
    + 'carriageway (issue #15)');
}

if (fail.length > 0) {
  console.error('FAIL\n  ' + fail.join('\n  '));
  process.exit(1);
}
console.error('PASS');
