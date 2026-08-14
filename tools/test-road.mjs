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
import { launchBrowser, newPage, wait, logPageErrors } from "./browser.mjs";
import { BASE as HOST } from "./target.mjs";

// `flatHalf` and `cellKey` USED TO LIVE HERE, and both are now defined inside
// the evaluate below for the reason the note on `GROUND` already gives: this
// tool's scope does not exist in the page. Hoisting them out made every run exit
// on `ReferenceError: flatHalf is not defined` before a single assertion ran.

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
const GROUND_SRC = "^(road:|terrain:|chunk:terrain|distant:terrain)";

const browser = await launchBrowser();
const page = await newPage(browser, { width: 900, height: 600 });
logPageErrors(page);
await page.goto(`${HOST}/?fps=30&menu=0`, { waitUntil: "load" });
await page.waitForSelector("canvas");
await wait(5000); // the corridor has to be streamed before it can be hit

const out = await page.evaluate((groundSrc) => {
  // Built in the PAGE, because that is where this whole function runs — a
  // regex closed over from the tool's own scope is not defined here. The same
  // goes for every helper this body calls, which is why these two are here.
  const GROUND = new RegExp(groundSrc);
  // THE RULE BELOW IS WRONG HERE, AND FOLLOWING IT IS WHAT BROKE THIS FILE.
  // `unicorn/consistent-function-scoping` sees a helper that captures nothing
  // and asks for it to be hoisted; hoisting it out of an evaluate body moves it
  // into a scope THE PAGE CANNOT SEE, and every run then died on
  // `ReferenceError: flatHalf is not defined` before one assertion ran. Same
  // reason the regex above is built here. Do not move these.
  /** Half the FLAT part of a path — what "on the carriageway" means. */
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page, not this module
  const flatHalf = (r) => Math.min(2.6, r.deckEdge * 0.52);
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page, not this module
  const cellKey = (cx, cz) => `${cx},${cz}`;
  const towns = window.__dbgTowns();

  // ONE INDEX, THEN THE WHOLE SWEEP. `__dbgSurfaceY` raycasts the scene per
  // column at 4.2 ms, which is four minutes for the ~35000 columns below and is
  // why this file stopped being runnable. The ray is always straight down, so
  // `__dbgSurfaceIndex` buckets the ground triangles once (~18 ms) and answers
  // a column in ~1.25 us — verified identical to the raycaster over 231 columns
  // spread across every road and its full width: same top surface, same mesh
  // name, worst disagreement 0.0005, which is `__dbgSurfaceY`'s own toFixed(3).
  //
  // NOTHING IS SAMPLED MORE COARSELY as a result, and that is the point: the
  // defects here are single columns, so the budget had to come out of the cost
  // per column rather than out of the number of them.
  const surfaceIndex = window.__dbgSurfaceIndex(groundSrc);

  /**
   * `__dbgSurfaceY`'s shape, rebuilt from one row entry, so the passes below
   * read exactly as they did. `hits` is the same topmost-first stack.
   */
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page, not this module
  const asHit = (row, i) => {
    const hits = [];
    for (let j = 0; j < row.count[i]; j++) {
      hits.push({
        y: +row.hitY[i * row.k + j].toFixed(3),
        name: row.names[row.hitName[i * row.k + j]],
      });
    }
    const top = hits[0] ?? null;
    return {
      ground: +row.ground[i].toFixed(3),
      surface: top ? top.y : null,
      hit: top ? top.name : null,
      sink: top ? +(top.y - row.ground[i]).toFixed(3) : null,
      hits,
    };
  };

  // -- what is drawn, against what is walked on ----------------------------
  const roads = towns.roads.map((r) => {
    const p = r.path;
    let worst = 0;
    let at = null;
    let over = 0;
    let tested = 0;
    for (let i = 1; i < p.length / 3; i++) {
      const ax = p[(i - 1) * 3],
        az = p[(i - 1) * 3 + 2];
      const bx = p[i * 3],
        bz = p[i * 3 + 2];
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az)));
      // One row per segment: the samples are already a straight line.
      const row = window.__dbgSurfaceRow(ax, az, (bx - ax) / steps, (bz - az) / steps, steps + 1);
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const x = ax + (bx - ax) * t;
        const z = az + (bz - az) * t;
        const s = asHit(row, k);
        // Only the ground surfaces answer this question; a bush overhead is not
        // something the hero is buried in. Both are named for exactly this.
        if (!s.hit || !GROUND.test(s.hit)) {
          continue;
        }
        tested++;
        if (s.sink > 0.2) {
          over++;
        }
        if (s.sink > worst) {
          worst = s.sink;
          at = {
            x: +x.toFixed(1),
            z: +z.toFixed(1),
            drawn: s.surface,
            walked: s.ground,
            by: s.hit,
          };
        }
      }
    }
    return { id: r.id, tested, worstSink: +worst.toFixed(3), over20cm: over, at };
  });

  // -- steps in the walking surface, on the carriageway only ---------------
  // Half the FLAT part of each path, which is what "on the carriageway" means:
  // 2.6 on the cart road, i.e. the number that used to be written in here once
  // for the whole world.
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
  //
  // BUCKETED, and the buckets are why this probe still finishes. The test is
  // asked once per 0.25-unit sample and used to scan EVERY segment in the
  // network, so its cost was samples x segments — and both of those grow with
  // the length of the roads. At the old 150-unit spacing that was ~5 minutes; at
  // a kilometre a leg (issue #184) the same sweep took 11m42s, on its way to
  // being unrunnable. A uniform grid answers from the handful of segments that
  // could possibly be within `half` of the point, which makes the sweep linear
  // in road length.
  //
  // IT IS AN INDEX, NOT A SAMPLE. Every column the old version tested is still
  // tested and the answer for each is identical — the duplicated work where two
  // arms overlap at the fork included, since a cell holds every segment that
  // reaches it. Subsampling was the other way to make this cheap and it is the
  // wrong one: the defects here are single columns, and a stride that halves the
  // cost halves the chance of standing on one.
  const CELL = 16;
  const grid = new Map();
  for (const seg of segs) {
    const [ax, az, bx, bz, half] = seg;
    const x0 = Math.floor((Math.min(ax, bx) - half) / CELL);
    const x1 = Math.floor((Math.max(ax, bx) + half) / CELL);
    const z0 = Math.floor((Math.min(az, bz) - half) / CELL);
    const z1 = Math.floor((Math.max(az, bz) + half) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = cellKey(cx, cz);
        let bucket = grid.get(k);
        if (!bucket) {
          grid.set(k, (bucket = []));
        }
        bucket.push(seg);
      }
    }
  }
  const onRoad = (x, z) => {
    const bucket = grid.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!bucket) {
      return false;
    }
    for (const [ax, az, bx, bz, half] of bucket) {
      const dx = bx - ax,
        dz = bz - az;
      const L = dx * dx + dz * dz || 1;
      let u = ((x - ax) * dx + (z - az) * dz) / L;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      if (Math.hypot(x - (ax + dx * u), z - (az + dz * u)) <= half) {
        return true;
      }
    }
    return false;
  };
  // NOT MEMOISED, and the attempt is worth recording. The sweep looks like it
  // asks for every column three times — once as itself, twice as a neighbour —
  // but a sample sits at `ax + tx*s - tz*d`, on the ROAD's rotated axes, while
  // its neighbours are offset along the WORLD's. The two lattices coincide only
  // by accident, so there is nothing to reuse; a cache keyed on the column
  // rounded to the sweep's own 0.25 merely hands back a DIFFERENT column's
  // height, which invents steps where the ground is fine and hides them where
  // it is not. Measured with one in: a phantom 0.7 against MAX_STEP_UP 0.5.
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page, not this module
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
      const ax = p[(i - 1) * 3],
        az = p[(i - 1) * 3 + 2];
      const bx = p[i * 3],
        bz = p[i * 3 + 2];
      let tx = bx - ax,
        tz = bz - az;
      const L = Math.hypot(tx, tz) || 1;
      tx /= L;
      tz /= L;
      for (let s = 0; s < L; s += S) {
        for (let d = -half; d <= half; d += S) {
          const x = ax + tx * s - tz * d;
          const z = az + tz * s + tx * d;
          if (!onRoad(x, z)) {
            continue;
          }
          const a = h(x, z);
          for (const [dx, dz] of [
            [S, 0],
            [0, S],
          ]) {
            if (!onRoad(x + dx, z + dz)) {
              continue;
            }
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
  // so only ground counts, and only where a ribbon is actually drawn (a town's
  // interior is route, not carriageway, and its yard is meant to show).
  //
  // IT RUNS OUTSIDE THIS EVALUATE, one road at a time. At cube resolution the
  // sweep is ~32000 raycasts, and the whole network in one `page.evaluate`
  // exceeds puppeteer's CDP `protocolTimeout` and comes back as a protocol
  // error rather than a result — which reads exactly like a crash. Per road it
  // is three calls of a few seconds each.

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
      tx /= L;
      tz /= L;
      const at = (d) => window.__dbgPaths(cx - tz * d, cz + tx * d).at.litter;
      const middle = at(0);
      const verge = Math.max(at(r.deckEdge * 0.8), at(r.deckEdge * 0.95), at(r.deckEdge));
      const beyond = at(r.deckEdge + 1.2);
      bands.push({ id: r.id, middle, verge, beyond });
      if (middle !== 0) {
        bad.push(`${r.id}: ${middle} litter down the middle`);
      }
      // BOTH KINDS OF PROFILE, each held to its own promise: a littered one
      // must shed at the verge, and a litter-free one (the waystone spur —
      // eight units of approach may not gravel the road they leave) must shed
      // NOTHING there either, or zero has quietly stopped meaning zero.
      if (r.litter === 0 ? verge !== 0 : !(verge > 0)) {
        bad.push(
          r.litter === 0
            ? `${r.id}: sheds ${verge} at the verge against a litter-free profile`
            : `${r.id}: nothing at the verge`,
        );
      }
      if (beyond !== 0) {
        bad.push(`${r.id}: ${beyond} litter past the skirt`);
      }
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
    const worn = all.filter((q) => q.profile === "path:track");
    // The DRAWN paths with their full polylines, which `__dbgTowns` has and
    // `__dbgPaths` (which reports a path's ends) does not.
    const drawn = window.__dbgTowns().roads.map((r) => ({
      path: r.path,
      deckEdge: r.deckEdge,
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
            if (Math.hypot(x - (ax + dx * u), z - (az + dz * u)) < half) {
              return true;
            }
          }
          return false;
        });
        if (nearRoad) {
          continue;
        }
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
        if (at.wear > 0) {
          wornSamples++;
        } else {
          bad.push(`${q.id} at t=${t}: wears nothing`);
        }
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
    /** What the sweep was answered from. `triangles` is the world it indexed. */
    surfaceIndex,
    ribbon: roads,
    profiles: towns.roads.map((r) => ({
      id: r.id,
      profile: r.profile,
      deckEdge: r.deckEdge,
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
      // Filled by the per-road pass below — see there for why it cannot live
      // in this evaluate.
      sampled: 0,
      /** Of those, the ones with a 1 m chunk under them. See the per-road pass. */
      nearGround: 0,
      terrainOverRibbon: 0,
      /** The clipmap, on the columns with no near chunk under them. */
      farOverRibbon: 0,
      worstFarPoke: 0,
      /** Per road, so a regression names its own corridor. */
      farByRoad: {},
      /** Columns where the ribbon is drawn over 0.2 ABOVE the walking surface. */
      ribbonOverWalk: 0,
      worstBuried: 0,
      buriedAt: null,
      worstPoke: 0,
      at: null,
      // A BUDGET, NOT A ZERO, and the zero it replaces was a fiction: this
      // counted hits whose mesh name starts `terrain:`, and `world/index.ts`
      // renames every terrain mesh to `chunk:terrain` on the way into the
      // scene, so it matched nothing and reported clean whatever the world
      // looked like.
      //
      // Corrected and swept at CUBE resolution, seed 1337 stands at 36 samples
      // of 32582 (0.11%), worst 0.770 — down from 191 of 5296 at worst 0.891
      // when the pattern was first fixed. What is left is a whole terrain cube
      // whose CELL resolved to a deck a metre away that rounds up, standing
      // under the middle of a ribbon chord: the rim guard can only lift the
      // vertices that bound the chord, and the ground can only be lowered where
      // the cell's own centre is inside the rim or the hero starts floating on
      // the kerb. Both were built and measured; see `sectionAt` and the note in
      // `Terrain.columnInfo`. It needs the ribbon tessellated to the cell grid,
      // which is the change that made the road read as torn paper (see `XS`).
      //
      // The budget is what was measured, so the residue cannot grow back to the
      // 191 unnoticed, and the ceiling is the 1.0 that says "a whole cube".
      clean: false,
    },
    litter,
    tracks,
    furniture: f,
  };
}, GROUND_SRC);

// -- the cross-section, one road per evaluate -------------------------------
for (const id of out.ribbon.map((r) => r.id)) {
  const part = await page.evaluate(
    (roadId, groundSrc) => {
      const GROUND = new RegExp(groundSrc);
      // Same instrument as the main evaluate. The index lives in the page, so
      // it is already built; rebuilding here would only re-walk the triangles.
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page, not this module
      const asHit = (row, i) => {
        const hits = [];
        for (let j = 0; j < row.count[i]; j++) {
          hits.push({
            y: +row.hitY[i * row.k + j].toFixed(3),
            name: row.names[row.hitName[i * row.k + j]],
          });
        }
        const top = hits[0] ?? null;
        return {
          ground: +row.ground[i].toFixed(3),
          surface: top ? top.y : null,
          hit: top ? top.name : null,
          sink: top ? +(top.y - row.ground[i]).toFixed(3) : null,
          hits,
        };
      };
      const r = window.__dbgTowns().roads.find((q) => q.id === roadId);
      const poke = {
        sampled: 0,
        near: 0,
        over: 0,
        worst: 0,
        at: null,
        far: 0,
        farWorst: 0,
        // BURIED: how far the ribbon is drawn ABOVE what the hero stands on, at
        // the same columns. The `sink` pass at the top of this file measures the
        // same thing down the CENTRELINE, where the deck and the ribbon agree by
        // construction — so it read 0.034 while the rim was 1.031 and the hero
        // was in the road up to his waist. This is the reading that says whether
        // an actor can walk on the surface it is looking at.
        sunk: 0,
        sunkWorst: 0,
        sunkAt: null,
      };
      if (!r) {
        return poke;
      }
      const DECK_EDGE = r.deckEdge;
      const p = r.path;
      for (let i = 1; i < p.length / 3; i++) {
        const ax = p[(i - 1) * 3];
        const az = p[(i - 1) * 3 + 2];
        const bx = p[i * 3];
        const bz = p[i * 3 + 2];
        let tx = bx - ax;
        let tz = bz - az;
        const L = Math.hypot(tx, tz) || 1;
        tx /= L;
        tz /= L;
        // CUBE RESOLUTION. This swept 1.5 along and 0.6 across, and a terrain
        // cube is 1x1 — so it stepped clean over single cube corners, which is
        // exactly the shape of the defect that survived: a road at an angle to
        // the voxel grid meets it corner-first. 0.5 and 0.25 land inside every
        // cell. A sweep that cannot see the failure is not cheaper, it is
        // decorative.
        for (let s = 0; s < L; s += 0.5) {
          const cx = ax + tx * s;
          const cz = az + tz * s;
          // The across sweep at a fixed `s` is a straight line, so it is one row.
          const d0 = -(DECK_EDGE - 0.05);
          const across = Math.floor((DECK_EDGE - 0.05 - d0) / 0.25) + 1;
          const row = window.__dbgSurfaceRow(
            cx - tz * d0,
            cz + tx * d0,
            -tz * 0.25,
            tx * 0.25,
            across,
          );
          let col = -1;
          for (let d = d0; d <= DECK_EDGE - 0.05; d += 0.25) {
            const x = cx - tz * d;
            const z = cz + tx * d;
            col++;
            if (col >= across) {
              break;
            }
            const hit = asHit(row, col);
            if (!hit.hits.some((q) => q.name.startsWith("road:"))) {
              continue;
            }
            poke.sampled++;
            // ONLY WHERE THE NEAR GROUND IS ACTUALLY IN THE SCENE.
            //
            // The streamer keeps a radius around the hero, and a road is 72 to
            // 174 units long — so most of the network has no 1 m chunk under it
            // while this runs, only the coarse clipmap. Counting those columns
            // reports a clean road that simply has not been built yet: measured,
            // the same sweep found 4 defects with a 5 s settle and 36 with a
            // longer one, and the difference was entirely chunks arriving. So
            // `sampled` is every column with a ribbon and `near` is the subset
            // this can actually answer for, and the budget is set against `near`.
            if (!hit.hits.some((q) => q.name.startsWith("chunk:terrain"))) {
              // THE FAR GROUND, counted separately rather than skipped. The HLOD
              // samples every 8-24 units and used to chord straight over a
              // corridor — 168 samples of clipmap drawn above the ribbon, and the
              // flat green wedges in the report. It is clamped under every path
              // now (`underPaths`, distant-terrain.ts) and this is what keeps it
              // that way, on exactly the columns the near sweep cannot judge.
              const far = hit.hits.find((q) => q.name.startsWith("distant:terrain"));
              const nearest = hit.hits.find((q) => q.name.startsWith("road:"));
              if (far && nearest && far.y > nearest.y) {
                poke.far++;
                if (far.y - nearest.y > poke.farWorst) {
                  poke.farWorst = far.y - nearest.y;
                }
              }
              continue;
            }
            poke.near++;
            // `hit.ground` is `getHeight` and the raycast already carries it —
            // a second `__dbgWorld` per sample pushed this evaluate past
            // puppeteer's protocol timeout.
            const deck = hit.hits.find((q) => q.name.startsWith("road:"));
            const walk = hit.ground;
            const buried = deck.y - walk;
            if (buried > 0.2) {
              poke.sunk++;
            }
            if (buried > poke.sunkWorst) {
              poke.sunkWorst = buried;
              poke.sunkAt = {
                x: +x.toFixed(1),
                z: +z.toFixed(1),
                fromCentre: +d.toFixed(1),
                ribbon: deck.y,
                walk,
                by: +buried.toFixed(3),
              };
            }
            if (!GROUND.test(hit.hit || "") || (hit.hit || "").startsWith("road:")) {
              continue;
            }
            const road = hit.hits.find((q) => q.name.startsWith("road:"));
            const by = hit.surface - road.y;
            if (by <= 0) {
              continue;
            }
            poke.over++;
            if (by > poke.worst) {
              poke.worst = by;
              poke.at = {
                x: +x.toFixed(1),
                z: +z.toFixed(1),
                fromCentre: +d.toFixed(1),
                ground: hit.surface,
                ribbon: road.y,
                road: roadId,
                by: +by.toFixed(3),
              };
            }
          }
        }
      }
      return poke;
    },
    id,
    GROUND_SRC,
  );
  out.crossSection.sampled += part.sampled;
  out.crossSection.nearGround += part.near;
  out.crossSection.terrainOverRibbon += part.over;
  out.crossSection.farOverRibbon += part.far;
  // WHICH ROAD, not just how many. The clipmap total is one number over the
  // whole network and a regression in it says nothing about where to look;
  // this is the line that named the trail.
  if (part.far > 0) {
    out.crossSection.farByRoad[id] = { n: part.far, worst: +part.farWorst.toFixed(3) };
  }
  out.crossSection.ribbonOverWalk += part.sunk;
  if (part.sunkWorst > out.crossSection.worstBuried) {
    out.crossSection.worstBuried = +part.sunkWorst.toFixed(3);
    out.crossSection.buriedAt = part.sunkAt;
  }
  if (part.farWorst > out.crossSection.worstFarPoke) {
    out.crossSection.worstFarPoke = +part.farWorst.toFixed(3);
  }
  if (part.worst > out.crossSection.worstPoke) {
    out.crossSection.worstPoke = +part.worst.toFixed(3);
    out.crossSection.at = part.at;
  }
}
// THE BUDGETS ARE WHAT WAS MEASURED, on 23151 near-ground columns of 32582.
//
//   ground through the gravel   45 -> 123, worst 0.899 -> 0.969 (OPEN)
//
// 34 of those became 123 when the zone gateway was biased toward wooded ground
// with a hillside behind it and moved to within thirty units of the trunk
// road: its flatten disc perturbs the carve where the two meet, and the same
// per-cell rounding produces more instances of the same defect. The WORST is
// unchanged, which is the tell that it is the same thing and not a new one.
// The trail laid to that gateway is clean — 0 pokes and 0 buried over its own
// 939 columns — so none of the increase is the new path type.
//   ribbon above the hero       250 -> 107, worst 0.737 -> 0.714 (OPEN)
//   far clipmap over the ribbon 168 -> 0                          (fixed)
//
// The first is not fixed and the budget is a ceiling, not a target. It is the
// cube-corner case on a road at an angle to the voxel grid, and both attempts
// at clipping the GROUND are worse than it — see `test-road-lab.mjs`, which
// isolates it as `angle` against an `axis` control.
//
// BOTH DIRECTIONS, and holding only one of them is how this went round in a
// circle: lifting the rim over the cubes took the first to 4 and the second to
// 1.031, which is the hero standing in the road up to his waist. They trade
// against each other because the ribbon is a chord over a surface that steps by
// a whole unit, and the only thing that improves both at once is ring spacing —
// see `subdivide` in town-parts.ts.
//
// 0.75 is the ceiling on each: the shoulder is levelled to within half a unit
// of the deck, so anything approaching a whole cube is a step rather than a
// rounding.
out.crossSection.clean =
  out.crossSection.worstPoke < 1.0 &&
  out.crossSection.terrainOverRibbon <= 140 &&
  out.crossSection.worstBuried < 0.75 &&
  out.crossSection.ribbonOverWalk <= 150 &&
  out.crossSection.worstFarPoke < 0.5 &&
  out.crossSection.farOverRibbon <= 10;

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
    fail.push(
      `${r.id}: ${r.over20cm} samples with the ribbon over 0.2 off the ` +
        `walking surface (worst ${r.worstSink})`,
    );
  }
}
if (out.carriageway.sampled === 0) {
  fail.push("the step sweep tested nothing");
}
if (!out.carriageway.walkable) {
  fail.push(
    `walking surface steps ${out.carriageway.worstStepOver025} on the ` +
      "carriageway, against MAX_STEP_UP 0.5",
  );
}
if (out.crossSection.sampled === 0) {
  fail.push("the cross-section sweep tested nothing");
}
if (!out.crossSection.clean) {
  fail.push(
    `${out.crossSection.terrainOverRibbon} of ${out.crossSection.sampled} ` +
      "cross-section samples have ground drawn over the ribbon (issue #15), " +
      `worst ${out.crossSection.worstPoke}; ${out.crossSection.ribbonOverWalk} with the ` +
      `ribbon ABOVE the walking surface at worst ${out.crossSection.worstBuried} ` +
      "(the hero standing IN the road); " +
      `${out.crossSection.farOverRibbon} of clipmap at worst ${out.crossSection.worstFarPoke}. ` +
      `Of ${out.crossSection.nearGround} near-ground columns. ` +
      "Budgets: 140 pokes and 150 buried under 0.75/1.0, 10 of clipmap under 0.5",
  );
}
if (!out.litter.pass) {
  fail.push(`path litter: ${out.litter.failures.join("; ") || "no path answered at all"}`);
}
if (!out.tracks.pass) {
  fail.push(`beaten tracks: ${out.tracks.failures.join("; ") || "none on the network"}`);
}
if (out.furniture.onCarriageway > 0) {
  fail.push(
    `${out.furniture.onCarriageway} pieces of road furniture stand on a ` +
      "carriageway (issue #15)",
  );
}

if (fail.length > 0) {
  console.error("FAIL\n  " + fail.join("\n  "));
  process.exit(1);
}
console.error("PASS");
