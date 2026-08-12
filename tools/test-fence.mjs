// Verifies the fence system (src/world/fences.ts) and the bridge deck's
// underside (src/world/town-parts.ts, `buildRoadRibbon`) — issue #105.
//
// Usage: bun tools/test-fence.mjs        (dev server must be up)
//
// ONE CHECKER, TWO WORLDS. The invariant is a statement about numbers —
//
//   * every bay is a gap the system chose, inside [minGap, maxGap];
//   * a bay's plank is exactly as long as the gap between its two posts;
//   * that plank is narrower than the posts and recessed inside their faces;
//   * that plank sits at a height BOTH posts reach, i.e. under the lower one's
//     top and over both bases;
//   * a run starts and ends on a post, and a closed one has no seam;
//   * a stake is planted rather than hovering over the ground it stands on;
//   * and NO PLANK IS INSIDE THE GROUND — the lowest one clears the highest
//     surface anywhere along its own bay, middle included, or the bay carries no
//     planks at all.
//
// That last one is checked TWICE on the stage and deliberately: once against the
// builder's own `groundMax` reading, and once against the stage's ground field
// re-sampled here at a finer pitch than the builder uses. A measurement that
// only ever checks itself is not a measurement.
//
// — so the same function runs it over the lab stage's demos (`?fence=all`,
// which builds a slope, a corner, a ring, a gated run, every post variant and a
// bridge) and over the fences the REAL WORLD built (`__dbgTowns().fences`). The
// stage is where a failure is diagnosable; the world is what ships, and a probe
// that only asserted the stage would be a probe that never saw a road.
//
// The bridge SOFFIT is asserted on the stage only, and deliberately: it is
// geometry `buildRoadRibbon` emits for every wet section, the stage's road goes
// through that same function, and counting down-facing triangles needs the
// scene graph rather than a debug hook. Zero of them is the bug in the issue's
// first screenshot — you look through the bridge and out the other side.
import { launchBrowser, newPage } from "./browser.mjs";
import { BASE as HOST, NO_WARMUP } from "./target.mjs";
import { buildFence } from "../src/world/fences.ts";
import { TownParts } from "../src/world/town-parts.ts";

/** `buildFence`'s own defaults. A run outside these chose them itself. */
const MAX_GAP = 3.2;
const MIN_GAP = 1.6;
/** Floating-point slack: three decimals is what the hooks round to. */
const EPS = 0.002;
/** `buildFence`'s own `DEFAULT_CLEARANCE`: how far a plank clears the surface. */
const CLEARANCE = 0.08;

const fails = [];
const out = {};

/** The cross-section contract that prevents issue #127's coplanar faces. */
function checkKit(kit, label) {
  if (!(kit.postWidth > 0) || !(kit.railWidth > 0) || !(kit.railHeight > 0)) {
    fails.push(`${label}: fence kit reports no usable post/rail dimensions`);
    return;
  }
  if (kit.railWidth >= kit.postWidth - EPS) {
    fails.push(
      `${label}: ${kit.railWidth.toFixed(3)}-wide plank is not recessed inside ` +
        `${kit.postWidth.toFixed(3)}-wide posts`,
    );
  }
  const top = kit.railAt.at(-1) + kit.railHeight;
  if (top >= kit.postH - EPS) {
    fails.push(
      `${label}: top plank reaches ${top.toFixed(3)}, leaving no cap below ` +
        `${kit.postH.toFixed(3)}-high posts`,
    );
  }
}

// Exercise the REAL stamp call without WebGL. The debug metrics below prove the
// kit is authored thin; this proves buildFence actually applies that x scale.
{
  const kit = new TownParts().fence;
  const calls = [];
  const stamp = { add: (...args) => calls.push(args) };
  buildFence(stamp, kit, [
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 3 },
  ]);
  const rails = calls.filter(([tpl]) => tpl === kit.rail || tpl === kit.railProp);
  const want = kit.railWidth / kit.postWidth;
  if (rails.length !== kit.railAt.length) {
    fails.push(`stamp: expected ${kit.railAt.length} rail courses, got ${rails.length}`);
  }
  for (const [, , , , , sx] of rails) {
    if (Math.abs(sx - want) > 1e-6 || sx >= 1) {
      fails.push(`stamp: rail x scale ${sx} does not recess it to ${want}`);
    }
  }
}

/**
 * The invariant, over one chain. `kit` is the fence kit's own metrics, so the
 * check is against what the builder painted rather than against a number typed
 * in here twice.
 */
function checkFence(f, kit, label) {
  const where = (msg) => fails.push(`${label}: ${msg}`);
  const railTopAt = (y) => y + kit.railAt[kit.railAt.length - 1];

  if (f.posts.length < 2) {
    where(`a fence with ${f.posts.length} post(s) is not a fence`);
    return;
  }
  if (f.bays.length < 1) {
    where("no bays");
  }
  // A CONTINUOUS chain: one bay per post on a ring, one fewer on an open run.
  // A refused bay does not leave a hole here — it ends the chain and starts
  // another, which is why `buildFence` hands back a list. See its `Fence`.
  const wantBays = f.closed ? f.posts.length : f.posts.length - 1;
  if (f.bays.length !== wantBays) {
    where(`${f.posts.length} posts but ${f.bays.length} bays (expected ${wantBays})`);
  }

  for (let i = 0; i < f.bays.length; i++) {
    const b = f.bays[i];
    const a = f.posts[b.from];
    const c = f.posts[b.to];
    if (!a || !c) {
      where(`bay ${i} names a post that does not exist`);
      continue;
    }

    // THE PLANK IS THE GAP. `length` is what the stamp's length scale divides
    // by, so if it disagrees with the distance between the posts the plank is
    // either short of one of them or through it — which is the issue's third
    // screenshot exactly.
    const gap = Math.hypot(a.x - c.x, a.z - c.z);
    if (Math.abs(gap - b.length) > EPS) {
      where(`bay ${i} spans ${gap.toFixed(3)} but its plank is ${b.length.toFixed(3)}`);
    }
    if (b.length > MAX_GAP + EPS) {
      where(`bay ${i} is ${b.length.toFixed(3)} long, over the ${MAX_GAP} limit`);
    }
    if (f.bays.length > 1 && b.length < MIN_GAP - EPS) {
      where(`bay ${i} is ${b.length.toFixed(3)} long, under the ${MIN_GAP} floor`);
    }
    // ...AND BOTH POSTS CARRY IT. Over the lower post's top is a plank ending
    // in mid-air; under a post's base is a plank in the ground.
    for (const p of [a, c]) {
      if (railTopAt(b.y) > p.y + kit.postH + EPS) {
        where(
          `bay ${i}'s top plank (${railTopAt(b.y).toFixed(3)}) clears the post ` +
            `at ${p.x.toFixed(1)},${p.z.toFixed(1)} (top ${(p.y + kit.postH).toFixed(3)})`,
        );
      }
      if (b.y + kit.railAt[0] < p.base - EPS) {
        where(
          `bay ${i}'s lowest plank is under the foot of the post ` +
            `at ${p.x.toFixed(1)},${p.z.toFixed(1)}`,
        );
      }
    }
  }

  // ...AND THE GROUND BETWEEN THEM. A plank is a straight chord over ground
  // that is a staircase of whole-unit columns, so both ends can be clear while
  // the step in the middle is not — the fence inside the bank in issue #105's
  // follow-up. `groundMax` is the builder's own sample of that middle.
  for (let i = 0; i < f.bays.length; i++) {
    const b = f.bays[i];
    if (b.groundMax === undefined) {
      continue;
    }
    if (b.y + kit.railAt[0] < b.groundMax + CLEARANCE - EPS) {
      where(
        `bay ${i}'s bottom plank (${(b.y + kit.railAt[0]).toFixed(3)}) is inside ` +
          `the ground (${b.groundMax.toFixed(3)}) somewhere along it`,
      );
    }
  }

  for (const p of f.posts) {
    if (p.base > p.y + EPS) {
      where(`a post at ${p.x.toFixed(1)},${p.z.toFixed(1)} is footed above its own line`);
    }
    // Only where the stage told us what the ground is, and never on a railing:
    // a railing stands on a DECK with the river bed below it, which is the
    // whole reason `buildFence` clamps how far a stake follows the ground down.
    if (p.ground !== undefined && label !== "lab:bridge" && p.base > p.ground + EPS) {
      where(
        `a post at ${p.x.toFixed(1)},${p.z.toFixed(1)} hangs ` +
          `${(p.base - p.ground).toFixed(3)} over the ground`,
      );
    }
  }
}

const browser = await launchBrowser();

// ---------- 1. the stage: every shape a fence has to cope with ----------
{
  const page = await newPage(browser, { width: 1280, height: 800 });
  await page.goto(`${HOST}/lab.html?fence=all&vol=0&fps=30`, { waitUntil: "load" });
  await page.waitForSelector("canvas");
  await page.waitForFunction(() => !!window.__dbgFence, { timeout: 10000 });
  const stage = await page.evaluate(() => window.__dbgFence());
  checkKit(stage.kit, "lab");

  const demos = new Set(stage.fences.map((f) => f.label));
  for (const want of ["slope", "turn", "ring", "gate", "variants", "bridge"]) {
    if (!demos.has(want)) {
      fails.push(`the stage built no "${want}" fence`);
    }
  }
  for (const f of stage.fences) {
    checkFence(f, stage.kit, `lab:${f.label}`);
  }

  // Every post variant reachable, and lanterns among them: a variant nothing
  // ever stamps is a variant nobody would notice breaking.
  const kinds = new Set(stage.fences.flatMap((f) => f.posts.map((p) => p.kind)));
  for (const k of ["post", "tall", "lantern"]) {
    if (!kinds.has(k)) {
      fails.push(`no "${k}" post was stamped anywhere on the stage`);
    }
  }

  // THE SAME QUESTION, ASKED OF THE STAGE'S OWN GROUND rather than of the
  // builder's reading of it, and at a finer pitch than the builder samples
  // (0.15 against its 0.4). `groundAt` is four lines of arithmetic, so the probe
  // can evaluate it in the page and compare like for like.
  const resampled = await page.evaluate((clear) => {
    const g = window.__dbgStageGround;
    const bad = [];
    for (const f of window.__dbgFence().fences) {
      for (let i = 0; i < f.bays.length; i++) {
        const b = f.bays[i];
        const a = f.posts[b.from];
        const c = f.posts[b.to];
        const steps = Math.max(1, Math.ceil(b.length / 0.15));
        let hi = -Infinity;
        for (let k = 0; k <= steps; k++) {
          const t = k / steps;
          hi = Math.max(hi, g(a.x + (c.x - a.x) * t, a.z + (c.z - a.z) * t));
        }
        const plank = b.y + 0.42;
        if (plank < hi + clear - 0.002) {
          bad.push({ fence: f.label, bay: i, plank: +plank.toFixed(3), ground: +hi.toFixed(3) });
        }
      }
    }
    return bad;
  }, CLEARANCE);
  for (const b of resampled) {
    fails.push(
      `lab:${b.fence}: bay ${b.bay}'s plank (${b.plank}) is under the ` +
        `stage's own ground (${b.ground}), re-sampled at 0.15`,
    );
  }
  out.resampledBad = resampled.length;

  // A REFUSED BAY ENDS A CHAIN AND STARTS ANOTHER. The gated demo refuses the
  // bays over the middle of its run, so it must come back as two continuous
  // fences rather than as one with a hole in it — which is the whole reason
  // `buildFence` returns a list.
  const gate = stage.fences.filter((f) => f.label === "gate");
  if (gate.length < 2) {
    fails.push(
      `the gated run came back as ${gate.length} chain(s): ` +
        "`accept` did nothing, or the gap was left inside a chain",
    );
  }

  // ---- the bridge's underside ----
  const deck = (stage.road ?? []).filter((p) => p.bridge);
  const lowestDeck = Math.min(...deck.map((p) => p.y));
  if (!deck.length) {
    fails.push("the stage road crosses no water");
  }
  if (stage.soffit.tris === 0) {
    fails.push("the bridge deck has no down-facing triangles: you can see through it");
  }
  if (stage.soffit.minY >= lowestDeck) {
    fails.push(`the soffit (${stage.soffit.minY}) is not under the deck (${lowestDeck})`);
  }

  out.stage = {
    fences: stage.fences.map((f) => ({
      label: f.label,
      posts: f.posts.length,
      bays: f.bays.length,
      closed: f.closed,
      longestBay: +Math.max(...f.bays.map((b) => b.length)).toFixed(3),
      shortestBay: +Math.min(...f.bays.map((b) => b.length)).toFixed(3),
    })),
    postKinds: [...kinds].toSorted(),
    railProfile: {
      postWidth: stage.kit.postWidth,
      railWidth: stage.kit.railWidth,
      faceInset: +((stage.kit.postWidth - stage.kit.railWidth) * 0.5).toFixed(3),
      railHeight: stage.kit.railHeight,
      topClearance: +(stage.kit.postH - stage.kit.railAt.at(-1) - stage.kit.railHeight).toFixed(3),
    },
    bridge: {
      wetSamples: deck.length,
      lowestDeck: +lowestDeck.toFixed(3),
      soffitTris: stage.soffit.tris,
      soffitY: stage.soffit.minY,
      thickness: +(lowestDeck - stage.soffit.minY).toFixed(3),
    },
  };
  await page.close();
}

// ---------- 2. the world: the fences a real road network built ----------
{
  const page = await newPage(browser, { width: 1280, height: 800 });
  await page.goto(`${HOST}/?menu=0&vol=0&fs=0&${NO_WARMUP}`, { waitUntil: "load" });
  await page.waitForSelector("canvas");
  await page.waitForFunction(() => window.__dbgBoot?.().playing, { timeout: 30000 });
  const world = await page.evaluate(() => {
    const t = window.__dbgTowns();
    return { fences: t.fences, kit: t.fenceKit };
  });

  // Checked against the kit's OWN metrics, which is the same object the lab
  // stage stamps from — `TownParts.fence`. A number typed in here would be a
  // second copy of the builder's, and it would go stale.
  if (!world.kit) {
    fails.push("__dbgTowns() reports no fence kit metrics");
  }
  if (!world.fences.length) {
    fails.push("the world built no fences at all");
  }
  const use = world.kit ?? {
    postH: 1.68,
    postWidth: 0.28,
    railAt: [0.42, 0.98],
    railWidth: 0.168,
    railHeight: 0.56,
  };
  checkKit(use, "world");
  world.fences.forEach((f, i) => checkFence(f, use, `world:${i}`));

  const bays = world.fences.flatMap((f) => f.bays);
  const clearances = bays.map((b) => b.y + use.railAt[0] - b.groundMax);
  out.world = {
    chains: world.fences.length,
    posts: world.fences.reduce((n, f) => n + f.posts.length, 0),
    bays: bays.length,
    /** Chains of one bay: a run that a gate or a bank cut down to nothing much. */
    stubs: world.fences.filter((f) => f.bays.length === 1).length,
    /** The tightest a plank comes to the ground under it, over the whole world. */
    tightestClearance: clearances.length ? +Math.min(...clearances).toFixed(3) : null,
    longestBay: bays.length ? +Math.max(...bays.map((b) => b.length)).toFixed(3) : null,
    lanterns: world.fences.reduce(
      (n, f) => n + f.posts.filter((p) => p.kind === "lantern").length,
      0,
    ),
  };
  await page.close();
}

out.pass = fails.length === 0;
if (fails.length) {
  out.failures = fails;
}
console.log(JSON.stringify(out, null, 2));
await browser.close();
process.exit(fails.length ? 1 : 0);
