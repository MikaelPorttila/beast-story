// PATH PROFILES — the second probe in tools/ that never opens a browser.
//
// A `PathProfile` (src/world/path-profile.ts) is a bundle of numbers DERIVED
// from a path's width, and it exists because they used to be about fifteen
// separate module constants folded off one number by hand across five files.
// Two different things can go wrong with a derivation like that, and neither is
// visible in a screenshot:
//
//   drift — the derivation stops reproducing the road that shipped. Every
//           constant it replaced is written out here as a literal, so a change
//           to a ratio that quietly moves the cart road fails HERE rather than
//           in test-road's cross-section sweep half an hour later. This is the
//           "must move no pixel" half of issue #142, asserted directly.
//   shape — a profile at some OTHER width is internally inconsistent: a
//           shoulder ramp wider than the verge it runs over, a carve core past
//           its own blend, a cross-section that is not sorted. Those are the
//           failures that would reopen issue #15 on a path type nobody has
//           written yet, so the invariants are swept over a range of widths
//           rather than checked on the two profiles that exist.
//
// Arithmetic only — no WebGL, no dev server, no world.
//
//   bun tools/test-path-profile.mjs
import {
  pathProfile,
  ROAD_PROFILE,
  FOOTPATH_PROFILE,
  MAX_CARVE_BLEND,
} from "../src/world/path-profile.ts";

const fail = [];
const near = (a, b) => Math.abs(a - b) < 1e-9;
const eq = (what, got, want) => {
  if (!near(got, want)) {
    fail.push(`${what}: ${got}, expected ${want}`);
  }
};
const ok = (what, cond) => {
  if (!cond) {
    fail.push(what);
  }
};

// -- the cart road, number for number ---------------------------------------
//
// These are the constants this file replaced. They are literals on purpose: a
// derivation checked against itself proves nothing.
const r = ROAD_PROFILE;
eq("road deckHalf (was DECK_HALF)", r.deckHalf, 2.8);
eq("road verge (was VERGE)", r.verge, 2.2);
eq("road deckEdge (was DECK_EDGE)", r.deckEdge, 5.0);
eq("road shoulderIn (was SHOULDER_IN)", r.shoulderIn, 0.8);
eq("road carveCore (was ROAD_CORE)", r.carveCore, 6.5);
eq("road carveBlend (was ROAD_BLEND)", r.carveBlend, 13);
eq("road sink (was the 0.62 in carveAt)", r.sink, 0.62);
eq("road carveInset (was CARVE_INSET)", r.carveInset, 0.75);
eq("road rimGuard (was RIM_GUARD)", r.rimGuard, 0.75);
eq("road apronR (was APRON_R)", r.apronR, 11);
eq("road avoidR (was AVOID_R)", r.avoidR, 18);
ok("road carves", r.carve === "full");
ok("road carries road furniture", r.furniture === "road");
ok("road bridges", r.bridges === true);
// A cart road sheds. The exact figure is taste; that it sheds at all is not,
// because `litterAt` returning 0 everywhere is a silent way to lose the feature.
ok("road sheds litter", r.litter > 0);
// The nine cross-section offsets `XS` used to spell out in town-parts.ts.
const XS = [-5, -4.2, -2.8, -1.26, 0, 1.26, 2.8, 4.2, 5];
eq("road xs length", r.xs.length, XS.length);
for (let i = 0; i < XS.length; i++) {
  eq(`road xs[${i}]`, r.xs[i], XS[i]);
}

// -- the footpath, as documented --------------------------------------------
const f = FOOTPATH_PROFILE;
eq("footpath deckHalf", f.deckHalf, 1.4);
eq("footpath deckEdge", f.deckEdge, 2.5);
eq("footpath verge", f.verge, 1.1);
eq("footpath shoulderIn", f.shoulderIn, 0.55);
eq("footpath carveCore", f.carveCore, 4);
eq("footpath carveBlend", f.carveBlend, 10.5);
eq("footpath apronR", f.apronR, 8.5);
eq("footpath avoidR", f.avoidR, 13);
ok("footpath carries no road furniture", f.furniture === "none");
ok("footpath does not bridge", f.bridges === false);
ok("footpath has its own palette", f.palette !== r.palette);
// MORE than the road's, and that ordering is the point rather than the values:
// nobody grades a footpath, so what falls on it stays.
ok("a footpath sheds more than a cart road", f.litter > r.litter);
ok("the two profiles have different ids", f.id !== r.id);

// -- the invariants, over widths nobody has authored yet ---------------------
//
// 0.7 to 6 covers a path narrower than the hero is wide up to one twice the
// cart road. Every one of these is a way the band could come apart.
for (let hw = 0.7; hw <= 6.0001; hw += 0.1) {
  const p = pathProfile({ id: `path:sweep-${hw.toFixed(1)}`, halfWidth: hw });
  const at = (what) => `halfWidth ${hw.toFixed(1)}: ${what}`;
  ok(at("verge is positive"), p.verge > 0);
  ok(at("deckEdge is deckHalf + verge"), near(p.deckEdge, p.deckHalf + p.verge));
  // THE BAND. `surfaceOf` divides by `verge - shoulderIn`, so a shoulder ramp
  // that reaches or passes the verge is a division by zero or a sign flip —
  // the walking surface would ramp the wrong way out of the carriageway.
  ok(at("shoulderIn is positive"), p.shoulderIn > 0);
  ok(at("shoulderIn is inside the verge"), p.shoulderIn < p.verge);
  // The earthworks have to be fully applied OUTSIDE the drawn rim and faded by
  // the blend, or the ribbon's outer edge lands on unlevelled ground.
  ok(at("carveCore is past the rim"), p.carveCore > p.deckEdge);
  ok(at("carveBlend is past carveCore"), p.carveBlend > p.carveCore);
  ok(at("carveBlend is within the index reach"), p.carveBlend <= MAX_CARVE_BLEND);
  // The apron has to clear an arm's own first ring, or the arm is drawn over
  // the disc it is supposed to grow out of.
  ok(at("apronR clears the rim"), p.apronR > p.deckEdge);
  // Two paths have to be able to run apart far enough to read as two.
  ok(at("avoidR clears two corridors"), p.avoidR > 2 * p.deckEdge);
  // The cross-section: nine offsets, sorted, symmetric, rim to rim.
  ok(at("xs has nine offsets"), p.xs.length === 9);
  eq(at("xs starts at -deckEdge"), p.xs[0], -p.deckEdge);
  eq(at("xs ends at deckEdge"), p.xs[8], p.deckEdge);
  eq(at("xs is centred"), p.xs[4], 0);
  for (let i = 1; i < p.xs.length; i++) {
    ok(at(`xs is ascending at ${i}`), p.xs[i] > p.xs[i - 1]);
    eq(at(`xs is symmetric at ${i}`), p.xs[i], -p.xs[8 - i]);
  }
  // The shoulder corner is a real vertex on the ramp, not on top of the rim or
  // on top of the carriageway edge — without it the ribbon chords under the
  // shoulder, which is 178 of issue #15's samples.
  ok(at("the shoulder corner is inside the rim"), p.xs[7] < p.deckEdge);
  ok(at("the shoulder corner is outside the deck"), p.xs[7] > p.deckHalf);
  eq(at("the shoulder corner is shoulderIn inside the rim"), p.xs[7], p.deckEdge - p.shoulderIn);
}

// -- litter is off by default -----------------------------------------------
//
// A profile that says nothing about shedding must shed nothing: the scatter
// rule in props.ts runs on every candidate a path refuses, so a non-zero
// default would put stones down every beaten track in every settlement.
const plain = pathProfile({ id: "path:sweep-plain", halfWidth: 2 });
eq("an unspecified profile sheds nothing", plain.litter, 0);

// -- what a no-carve profile is ---------------------------------------------
const trail = pathProfile({ id: "path:sweep-nocarve", halfWidth: 1.0, carve: "none" });
ok("a no-carve profile says so", trail.carve === "none");
ok("a no-carve profile still has a rim to draw to", trail.deckEdge > 0);

console.log(
  JSON.stringify(
    {
      road: { id: r.id, deckHalf: r.deckHalf, deckEdge: r.deckEdge, apronR: r.apronR },
      footpath: { id: f.id, deckHalf: f.deckHalf, deckEdge: f.deckEdge, apronR: f.apronR },
      widthsSwept: 54,
      failures: fail,
      pass: fail.length === 0,
    },
    null,
    2,
  ),
);

if (fail.length > 0) {
  console.error("FAIL\n  " + fail.join("\n  "));
  process.exit(1);
}
console.error("PASS");
