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
//   cross  — then a SECOND path, drawn deliberately across the trunk road, is
//            merged into a four-arm crossroads: both edges split, a node
//            between them, and the same two measurements over every arm of it.
//            A junction is where this world's worst step has always been — the
//            fork used to step 0.801 against a MAX_STEP_UP of 0.5, because
//            `surfaceAt` answers with the nearest deck and the nearest deck
//            jumps across the line equidistant from two of them.
//   panel  — and the F3 rows drive the SAME mechanism. The rule in this repo is
//            that a probe must not be able to pass a test the panel would fail,
//            so the last thing this does is open F3, click the rows and lay a
//            path with the mouse — no hook — and check the network grew.
//
// Exits non-zero on any of them.
//
//   bun tools/test-path-edit.mjs
import { launchBrowser, newPage, wait, logPageErrors } from "./browser.mjs";
import { BASE as HOST } from "./target.mjs";

const browser = await launchBrowser();
const page = await newPage(browser, { width: 900, height: 600 });
logPageErrors(page);
await page.goto(`${HOST}/?fps=30&menu=0&fs=0&enemies=0&beasts=0`, { waitUntil: "load" });
await page.waitForSelector("canvas");
await wait(5000);

// -- the refusals, before anything is built ---------------------------------
const refusals = await page.evaluate(() => {
  const p = window.__dbgPlayerPos();
  return {
    unknownProfile: window.__dbgAddPath(p.x, p.z, p.x + 60, p.z + 40, "cobblestone"),
    tooShort: window.__dbgAddPath(p.x, p.z, p.x + 3, p.z + 1, "footpath"),
    // INTO THE WATER. On seed 1337 this bearing runs down to the shore and
    // ends on the waterline; a footpath cannot bridge, so `profileRoad` would
    // floor its wet samples 1.9 above the surface and hand back a deck with
    // nothing under it and no piers to put there. See `World.addPath`.
    intoWater: window.__dbgAddPath(p.x, p.z, p.x + 78, p.z + 46, "footpath"),
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
  const r = window.__dbgAddPath(p.x, p.z, p.x + 60, p.z - 40, "footpath");
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
      tx /= L;
      tz /= L;
      for (let s = 0; s < L; s += 1.5) {
        const cx = ax + tx * s;
        const cz = az + tz * s;
        for (let d = -(DECK_EDGE - 0.2); d <= DECK_EDGE - 0.2; d += 0.6) {
          const x = cx - tz * d;
          const z = cz + tx * d;
          const hit = window.__dbgSurfaceY(x, z, 2);
          if (!hit.hits.some((q) => q.name.startsWith("road:"))) {
            continue;
          }
          poke.sampled++;
          if (!/^terrain:/.test(hit.hit || "")) {
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

// -- and now one that CROSSES ------------------------------------------------
//
// Perpendicular to the trunk at its midpoint, with `cross` on so the router is
// not charged 50 a step for going near it (§12d). The trunk is the road the
// player spawns on, so a crossroads there is also the one an eye would land on.
const crossed = await page.evaluate(() => {
  const t = window.__dbgTowns().roads.find((q) => q.id === "camp-junction");
  const n = t.path.length / 3;
  const i = Math.floor(n * 0.5);
  const cx = t.path[i * 3];
  const cz = t.path[i * 3 + 2];
  const j = Math.min(n - 1, i + 3);
  let tx = t.path[j * 3] - cx;
  let tz = t.path[j * 3 + 2] - cz;
  const L = Math.hypot(tx, tz) || 1;
  tx /= L;
  tz /= L;
  const drawnBefore = window.__dbgTowns().roads.length;
  const r = window.__dbgAddPath(
    cx + tz * 45,
    cz - tx * 45,
    cx - tz * 45,
    cz + tx * 45,
    "road",
    true,
  );
  return { r, drawnBefore, node: { x: cx, z: cz } };
});
await wait(6000);

const merged = await page.evaluate((made) => {
  const drawn = window.__dbgTowns().roads;
  const node = made.r.nodes[0] ?? null;
  // Every arm of the crossroads: the two halves of the trunk and the two of
  // the path that cut it. A split names its halves `<id>#a` and `<id>#b`.
  const arms = drawn.filter((r) => /#[ab]$/.test(r.id));
  const poke = { sampled: 0, over: 0, worst: 0, at: null };
  let step = 0;
  let stepAt = null;
  if (node) {
    for (const r of arms) {
      const p = r.path;
      const E = r.deckEdge;
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
        for (let s = 0; s < L; s += 1.5) {
          for (let d = -(E - 0.2); d <= E - 0.2; d += 0.6) {
            const x = ax + tx * s - tz * d;
            const z = az + tz * s + tx * d;
            const hit = window.__dbgSurfaceY(x, z, 2);
            if (!hit.hits.some((q) => q.name.startsWith("road:"))) {
              continue;
            }
            poke.sampled++;
            if (!/^terrain:/.test(hit.hit || "")) {
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
              poke.at = { x: +x.toFixed(1), z: +z.toFixed(1), road: r.id };
            }
          }
        }
      }
    }
    // THE WALKING SURFACE ACROSS THE NODE ITSELF, swept as a disc rather than
    // along a line: the step a junction produces is between two decks, so it
    // lives on the boundary between them and a centreline sample walks right
    // past it.
    //
    // ON THE CARRIAGEWAY ONLY, which is the same filter `test-road`'s sweep
    // uses and is not a way of avoiding an awkward number. Between two arms the
    // apron is DRAWN out to a fillet but the ground there is ordinary terrain,
    // which steps by whole units everywhere in this world on purpose — measured
    // without this, the worst "junction step" was 1.000 at 10.8 units from the
    // node, in a wedge with no carriageway in it. What the hero can walk over
    // is the flat part of an arm, or the middle of the disc.
    const h = (x, z) => window.__dbgWorld(x, z).ground;
    const S = 0.25;
    const R = 11;
    const onDeck = (x, z) => {
      if (Math.hypot(x - node.x, z - node.z) <= 5) {
        return true;
      }
      for (const r of arms) {
        const p = r.path;
        const half = Math.min(2.6, r.deckEdge * 0.52);
        for (let i = 3; i < p.length; i += 3) {
          const ax = p[i - 3];
          const az = p[i - 1];
          const dx = p[i] - ax;
          const dz = p[i + 2] - az;
          const L = dx * dx + dz * dz || 1;
          let u = ((x - ax) * dx + (z - az) * dz) / L;
          u = u < 0 ? 0 : u > 1 ? 1 : u;
          if (Math.hypot(x - (ax + dx * u), z - (az + dz * u)) <= half) {
            return true;
          }
        }
      }
      return false;
    };
    for (let dx = -R; dx <= R; dx += S) {
      for (let dz = -R; dz <= R; dz += S) {
        if (dx * dx + dz * dz > R * R) {
          continue;
        }
        const x = node.x + dx;
        const z = node.z + dz;
        if (!onDeck(x, z)) {
          continue;
        }
        const a = h(x, z);
        for (const [ex, ez] of [
          [S, 0],
          [0, S],
        ]) {
          if (!onDeck(x + ex, z + ez)) {
            continue;
          }
          const b = h(x + ex, z + ez);
          if (Math.abs(b - a) > step) {
            step = Math.abs(b - a);
            stepAt = { x: +x.toFixed(2), z: +z.toFixed(2) };
          }
        }
      }
    }
  }
  return {
    node,
    refused: made.r.refused,
    drawnBefore: made.drawnBefore,
    drawnAfter: drawn.length,
    arms: arms.map((r) => r.id),
    crossSection: {
      sampled: poke.sampled,
      terrainOverRibbon: poke.over,
      worstPoke: +poke.worst.toFixed(3),
      at: poke.at,
      clean: poke.over === 0,
    },
    apron: {
      worstStepOver025: +step.toFixed(3),
      at: stepAt,
      maxStepUp: 0.5,
      walkable: step < 0.5,
    },
  };
}, crossed);

// -- and now the PANEL, with no hook at all ---------------------------------
//
// §12h: a driver hook exists so a probe cannot pass a test the panel would
// fail, which only means anything if something also drives the panel. Every
// click below is a real click on a real row.
const panel = await page.evaluate(() => {
  const before = window.__dbgPaths().paths.length;
  const rows = [...document.querySelectorAll(".bs-perf-row[data-path]")];
  return { before, rows: rows.map((r) => r.getAttribute("data-path")) };
});
await page.keyboard.press("F3");
await wait(400);
const clicked = await page.evaluate(() => {
  const pick = (key) => document.querySelector(`.bs-perf-row[data-path="${key}"]`);
  const seen = [...document.querySelectorAll(".bs-perf-row[data-path]")].map((r) =>
    r.getAttribute("data-path"),
  );
  const before = window.__dbgPaths().paths.length;
  // Step the length row once so the click is doing something visible, then lay.
  const lenRow = pick("length");
  const lenBefore = lenRow?.querySelector(".bs-perf-val")?.textContent ?? "";
  lenRow?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  lenRow?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const lenAfter = pick("length")?.querySelector(".bs-perf-val")?.textContent ?? "";
  const lay = pick("lay");
  lay?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  lay?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  return {
    rows: seen,
    before,
    lenBefore,
    lenAfter,
    status: document.querySelector(".bs-spawn-status")?.textContent ?? "",
  };
});
await wait(6000);
const panelAfter = await page.evaluate(() => ({
  paths: window.__dbgPaths().paths.length,
  status: document.querySelector(".bs-spawn-status")?.textContent ?? "",
}));

console.log(
  JSON.stringify(
    {
      refusals,
      built,
      ...out,
      merged,
      panel: { ...panel, ...clicked, after: panelAfter },
    },
    null,
    2,
  ),
);
await browser.close();

const fail = [];
if (!refusals.unknownProfile.error) {
  fail.push("an unknown profile name was accepted instead of reported");
}
if (!refusals.tooShort.error) {
  fail.push("a path with both ends in the same place was accepted");
}
if (!refusals.intoWater.error) {
  fail.push(
    "a footpath was routed into the water instead of being refused — " +
      "it cannot bridge, so the deck would stand 1.9 over the surface on nothing",
  );
}
if (built.result.error) {
  fail.push(`the path was refused: ${built.result.error}`);
} else {
  if (out.added === null) {
    fail.push("the network did not gain the edge");
  } else if (out.added.profile !== "path:footpath") {
    fail.push(`the edge was built to ${out.added.profile}, not the profile asked for`);
  }
  if (out.drawnCount !== built.drawnBefore + 1) {
    fail.push(`drawn paths went ${built.drawnBefore} -> ${out.drawnCount}, expected one more`);
  }
  if (!out.edgeIsDrawn) {
    fail.push("the new edge is on the network but is not drawn");
  }
  if (out.crossSection.sampled === 0) {
    fail.push("the cross-section sweep found no ribbon over the new edge at all");
  }
  if (!out.crossSection.clean) {
    fail.push(
      `${out.crossSection.terrainOverRibbon} of ${out.crossSection.sampled} ` +
        "cross-section samples over the AUTHORED path have terrain drawn over the " +
        `ribbon (issue #15), worst ${out.crossSection.worstPoke}`,
    );
  }
  if (!out.carriageway.walkable) {
    fail.push(
      `the authored deck steps ${out.carriageway.worstStepOver025}, ` + "against MAX_STEP_UP 0.5",
    );
  }
}
// -0.05 and not 0: the hero rests a hair into the surface he stands on, and the
// failure this guards against is a whole carve depth (up to 1.62), not a
// rounding error.
// -- the crossroads ---------------------------------------------------------
if (merged.node === null) {
  fail.push(
    "the crossing was not merged into a junction: " +
      (merged.refused.join("; ") || "no reason given, which is its own bug"),
  );
} else {
  if (merged.node.arms !== 4) {
    fail.push(`the node reports ${merged.node.arms} arms, expected 4`);
  }
  // Two edges split into four, and the path itself is two of them: three drawn
  // paths become six.
  if (merged.drawnAfter !== merged.drawnBefore + 3) {
    fail.push(
      `drawn paths went ${merged.drawnBefore} -> ${merged.drawnAfter}, ` +
        "expected three more (two splits and the two halves of the new path)",
    );
  }
  if (merged.arms.length !== 4) {
    fail.push(
      `${merged.arms.length} split halves on the network, expected 4: ` + merged.arms.join(", "),
    );
  }
  if (merged.crossSection.sampled === 0) {
    fail.push("the cross-section sweep found no ribbon over the crossroads at all");
  }
  if (!merged.crossSection.clean) {
    fail.push(
      `${merged.crossSection.terrainOverRibbon} of ${merged.crossSection.sampled} ` +
        "cross-section samples over the MERGED crossroads have terrain drawn over " +
        `the ribbon (issue #15), worst ${merged.crossSection.worstPoke}`,
    );
  }
  if (!merged.apron.walkable) {
    fail.push(
      `the walking surface steps ${merged.apron.worstStepOver025} across the ` +
        "authored junction, against MAX_STEP_UP 0.5 — this is issue #15's fork step " +
        "at a node nobody planned",
    );
  }
}

// -- the panel --------------------------------------------------------------
if (clicked.rows.length !== 4) {
  fail.push(
    `the F3 panel shows ${clicked.rows.length} path rows, expected 4: ` + clicked.rows.join(", "),
  );
}
if (clicked.lenBefore === clicked.lenAfter) {
  fail.push(`clicking the length row did not change it (${clicked.lenBefore})`);
}
if (panelAfter.paths <= clicked.before) {
  fail.push(
    `clicking "lay it" left the network at ${panelAfter.paths} paths — ` +
      "the rows are drawn but they do nothing",
  );
}
if (!panelAfter.status) {
  fail.push("the panel laid a path and said nothing about it (issue #142 §12f)");
}

if (out.hero.clearance < -0.05) {
  fail.push(
    `the hero was left ${(-out.hero.clearance).toFixed(2)} inside the ground ` +
      "after the carve — see refitHero in main.ts",
  );
}

if (fail.length > 0) {
  console.error("FAIL\n  " + fail.join("\n  "));
  process.exit(1);
}
console.error("PASS");
