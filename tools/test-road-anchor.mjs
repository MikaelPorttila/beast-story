// DECK ANCHORS — a headless probe: `profileRoad` is arithmetic over a Terrain.
//
// `profileRoad` pins each end of a deck to a target height with a hold-plus-
// taper (`anchor` in src/world/roads.ts). The invariant is simple and was
// broken for every path shorter than two tapers: AN ANCHOR OWNS ITS OWN END.
// The taper used to run a fixed 14 samples, so on a 6-sample waystone spur the
// END anchor's tail reached back across the whole polyline and dragged the
// start 1.2 under the road deck it had just been anchored to — a 1.126 step in
// the walking surface where the spur leaves the carriageway (issue #213).
//
// Swept over every length from the shortest spur to a full inter-town leg, on
// real seed-1337 ground, with the start target offset the way a carved road
// deck really is offset from the natural column under its rim.
//
//   bun tools/test-road-anchor.mjs
import { Terrain, WATER_LEVEL } from "../src/world/terrain.ts";
import { profileRoad, SEG_LEN } from "../src/world/roads.ts";

const terrain = new Terrain(1337);

/**
 * Dry, sloped ground, FOUND rather than pinned: a hand-picked coordinate stops
 * being right the day the noise is touched (the road stage's own rule).
 */
function findSlope() {
  let best = -Infinity;
  let at = { x: 0, z: 0 };
  for (let x = -900; x <= 900; x += 40) {
    for (let z = -900; z <= 900; z += 40) {
      const rise = Math.abs(terrain.heightCont(x + 15, z) - terrain.heightCont(x - 15, z));
      // Every sample of the longest run must stay dry: a wet sample becomes a
      // bridge and `floorWater` may legitimately lift an end off its target.
      let dry = true;
      for (let s = -120; s <= 120; s += 10) {
        if (terrain.heightCont(x + s, z) < WATER_LEVEL + 3) {
          dry = false;
          break;
        }
      }
      if (dry && rise > best) {
        best = rise;
        at = { x, z };
      }
    }
  }
  return at;
}

const o = findSlope();
const fail = [];
const runs = [];

// 6 samples is the shipped waystone spur; 14 and 15 straddle one taper; 29
// straddles two (the old failure boundary); 81 is a leg no cap should touch.
for (const n of [4, 6, 10, 14, 15, 29, 81]) {
  // The spur's own spacing (2 units), except at full length where SEG_LEN is
  // the planner's.
  const step = n <= 29 ? 2 : SEG_LEN;
  const route = Array.from({ length: n }, (_, i) => ({ x: o.x - 60 + i * step, z: o.z }));
  const first = route[0];
  const last = route[n - 1];
  // The start is a DECK height, offset from natural ground the way a carved
  // road's rim is — that offset is what fed the runaway taper its delta.
  const startY = terrain.getHeight(first.x, first.z) + 1.2;
  const endY = terrain.getHeight(last.x, last.z);
  const pts = profileRoad(terrain, route, startY, endY);
  const missStart = +Math.abs(pts[0].y - startY).toFixed(3);
  const missEnd = +Math.abs(pts[n - 1].y - endY).toFixed(3);
  runs.push({ n, startY: +startY.toFixed(2), endY: +endY.toFixed(2), missStart, missEnd });
  // Exactly on target, bar float noise — the anchor's last write IS the target.
  if (missStart > 0.001) {
    fail.push(`n=${n}: the deck starts ${missStart} off its anchored height`);
  }
  if (missEnd > 0.001) {
    fail.push(`n=${n}: the deck ends ${missEnd} off its anchored height`);
  }
}

console.log(JSON.stringify({ at: o, runs }, null, 2));
if (fail.length > 0) {
  console.error("FAIL\n  " + fail.join("\n  "));
  process.exit(1);
}
console.error("PASS");
