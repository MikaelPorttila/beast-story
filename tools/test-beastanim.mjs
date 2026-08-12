// Beast animation continuity guard.
//
// Per beast and per rig joint, the LARGEST rotation change between two
// consecutive simulated frames. A procedural cycle is continuous by
// construction, so those deltas stay in the tenths of a radian; a joint that
// swings most of a radian between adjacent frames is not animating, it is
// teleporting, and that is what reads on screen as a flicker or an impossibly
// fast flap.
//
// ONE CHECKER, TWO WORLDS — the shape tools/test-fence.mjs uses, for the same
// reason. The rule is a statement about numbers, so it runs twice:
//
//   1. THE STAGE (lab.html?beasts=all&follow=1&t=0). Every species at once, all
//      of them in catch-up follow, stepped by __dbgLabAdvance rather than by a
//      rendered frame. This is the coverage half AND the cheap half.
//   2. THE WORLD (index.html). Two follow slots, a streamed world, carriers and
//      a wild population under them. This is what ships.
//
// WHY THE STAGE EXISTS AT ALL, given the world already ran. Both halves of the
// old version of this file were weak and its own comments said so:
//
//   * COVERAGE. In the game only two beasts occupy follow slots ("]" swaps the
//     primary, "[" the support); the other thirteen sit in reserve at
//     moveSpeed 0, where the bug cannot show. Alternating the two keys
//     oscillates around the starting pair instead of sweeping the roster, so a
//     species could go a whole run unmeasured. On the stage every species is a
//     follower simultaneously, and `follow=1` teleports the owner every 1.2 s
//     so all of them slam from a standstill into full catch-up together.
//   * COST AND FLAKE. The world half must soak a real clock (the phase error of
//     a `time * freq` cycle scales with elapsed time, so measuring at t~0
//     understates it by an order of magnitude) and must sample real frames. The
//     stage does neither: `__dbgLabAdvance` runs the same BeastActor.update at
//     a fixed 1/60 with nothing rendered, so 30 s of soak and 26 s of sample
//     cost about a second of CPU and give the same numbers twice.
//
// AND IT ASSERTS NOW. The old file printed a table and exited 0 whatever it
// found, which AGENTS.md calls out by name — a probe that cannot fail is a
// probe that is not run. See MAX_DELTA.
//
// Usage: bun tools/test-beastanim.mjs [soakSeconds]
import { launchBrowser, newPage, wait, logPageErrors } from "./browser.mjs";
import { BASE as HOST } from "./target.mjs";

/**
 * How long each half lets the session clock run before it starts measuring.
 *
 * THEY ARE DIFFERENT NUMBERS BECAUSE THEY COST DIFFERENT THINGS. The phase
 * error of a `time * freq` cycle is proportional to elapsed time, so a soak is
 * pure coverage — and on the stage it is nearly free (`__dbgLabAdvance` runs
 * 120 s of it in about 0.8 s of CPU), so the stage takes four minutes of clock
 * where it used to take thirty seconds. The world half pays wall clock for
 * every second of it, and its worst joints land in the first few seconds of
 * the sample rather than at the end, so it takes the short one and leaves the
 * long-clock case to the stage. An argument overrides the world's.
 */
const STAGE_SOAK_S = 120;
const soak = Number(process.argv[2] ?? 8);

// Long enough for the world half to cycle the roster through its two follow
// slots, and the same window on the stage so the two tables are comparable.
const SAMPLE_MS = 26000;

/** The stage's step, and __dbgLabAdvance's — src/lab/index.ts SIM_STEP. */
const SIM_STEP = 1 / 60;

/**
 * A frame this long is not evidence of an animation bug.
 *
 * The measurement is a per-frame delta, so it scales with the frame's own dt: a
 * joint moving at a legitimate 8 rad/s covers 0.13 rad in a 16 ms frame and
 * 0.8 rad in a 100 ms one. Under a software rasteriser, or beside two other
 * probes on one GPU, the world half sees plenty of 100 ms frames — so a sample
 * taken across one is dropped rather than counted, and the count of drops is
 * reported. The stage half never trips this: its dt is exactly SIM_STEP.
 */
const SLOW_FRAME_MS = 50;

/**
 * The budget, in radians between two adjacent frames.
 *
 * Measured with the sample below: the stage's worst joint over fifteen species
 * in catch-up is 0.30 rad and the world's is 0.28, both on wing and leg joints
 * at full moveSpeed, which is where the fastest legitimate motion is. 0.60 is
 * twice the observed worst — clear of the noise, and well under the "most of a
 * radian" that the flicker in the original report measured at (1.9 rad on
 * `frostwing.wingL.z`, a cycle whose phase jumped rather than advanced).
 *
 * Move this and say what you measured, as with any tuned constant here.
 */
const MAX_DELTA = 0.6;

/**
 * THE CHECKER, installed in whichever page is being measured.
 *
 * Folding one sample at a time — rather than collecting poses and diffing them
 * afterwards — is what lets the same rule serve a deterministic in-page loop on
 * the stage and a rAF collector in the game. It keeps only the worst delta per
 * joint, so a 26 s sample is a few hundred numbers however many frames it took.
 */
const installChecker = (page, slowFrameMs) =>
  page.evaluate((slowMs) => {
    const LOCO = new Set(["idle", "walk", "run", "fly", "swim"]);
    const worst = new Map(); // "beast.part.axis" -> worst per-frame delta
    let prev = null;

    window.__anim = {
      frames: 0,
      skipped: 0,
      clock: 0,
      /** Fold one frame in. `dtMs` is how long that frame took to produce. */
      fold(dtMs) {
        const now = window.__dbgBeastAnim();
        window.__anim.frames++;
        // The LARGEST clock in the roster, not the first one's: a beast parked in
        // reserve never updates, so its `time` sits at 0 and reading it would
        // report a session that never started.
        for (const b of now) {
          if (b.time > window.__anim.clock) window.__anim.clock = b.time;
        }
        if (prev && dtMs > slowMs) {
          window.__anim.skipped++;
          prev = now;
          return;
        }
        if (prev) {
          for (let i = 0; i < now.length && i < prev.length; i++) {
            const a = prev[i],
              b = now[i];
            if (a.id !== b.id) {
              continue;
            }
            // Only compare frames in the SAME action, and only the locomotion
            // actions. An action change is a deliberate pose cut — a beast
            // snapping out of an attack into a run is meant to move a long way in
            // one frame — and counting those would drown out the thing under
            // test, which is whether a cycle stays continuous WHILE it runs.
            if (a.action !== b.action) {
              continue;
            }
            if (!LOCO.has(b.action)) {
              continue;
            }
            for (const k of Object.keys(b.parts)) {
              const pa = a.parts[k],
                pb = b.parts[k];
              // The contact blob counter-rotates against the rig root to stay
              // flat on the ground, so its local rotation wraps through +-pi
              // every time the beast turns past south. That is a 2pi bookkeeping
              // step, not motion, and it drowns out everything real. Skip it.
              if (!pa || !pb || k === "blob") {
                continue;
              }
              for (let ax = 0; ax < 3; ax++) {
                const d = Math.abs(pb[ax] - pa[ax]);
                const key = `${b.id}.${k}.${"xyz"[ax]}`;
                const cur = worst.get(key);
                if (!cur || d > cur.d) {
                  worst.set(key, { d, action: b.action, ms: b.moveSpeed, t: b.time });
                }
              }
            }
          }
        }
        prev = now;
      },
      read() {
        const rows = [...worst.entries()]
          .map(([k, v]) => ({ joint: k, d: v.d, action: v.action, ms: v.ms, t: v.t }))
          .sort((a, b) => b.d - a.d);
        const perBeast = new Map();
        for (const r of rows) {
          const id = r.joint.split(".")[0];
          if (!perBeast.has(id)) {
            perBeast.set(id, r);
          }
        }
        const seen = [...perBeast.values()];
        return {
          elapsed: window.__anim.clock,
          frames: window.__anim.frames,
          skipped: window.__anim.skipped,
          top: rows.slice(0, 12),
          perBeast: seen,
          // A beast that never left its reserve slot reports a row of zeroes —
          // it is IN the roster and it was never measured. Counting those as
          // coverage is exactly the hole the stage half exists to close, so the
          // two numbers are reported apart.
          moving: seen.filter((r) => r.d > 1e-6).length,
        };
      },
    };
  }, slowFrameMs);

const browser = await launchBrowser();
const fails = [];

// ---------- 1. the stage: every species, in catch-up, deterministically -----
//
// `t=0` renders one frame and starts NO rAF loop, so __dbgLabAdvance is the
// only thing moving the clock — which is what makes this half reproducible.
const stage = await (async () => {
  const page = await newPage(browser, { width: 640, height: 400 });
  logPageErrors(page);
  await page.goto(`${HOST}/lab.html?beasts=all&follow=1&t=0&vol=0`, { waitUntil: "load" });
  await page.waitForFunction('typeof __dbgLabAdvance === "function"', { timeout: 30000 });
  await page.waitForFunction("__dbgBeastAnim().length > 0", { timeout: 30000 });
  await installChecker(page, SLOW_FRAME_MS);

  const out = await page.evaluate(
    (soakS, sampleS, step) => {
      const t0 = performance.now();
      // The soak, in one call: elapsed session clock is an input to the bug, and
      // nothing needs to be sampled while it accumulates.
      window.__dbgLabAdvance(soakS);
      const steps = Math.round(sampleS / step);
      for (let i = 0; i < steps; i++) {
        window.__dbgLabAdvance(step);
        window.__anim.fold(step * 1000);
      }
      return { ...window.__anim.read(), wallMs: Math.round(performance.now() - t0) };
    },
    STAGE_SOAK_S,
    SAMPLE_MS / 1000,
    SIM_STEP,
  );

  await page.close();
  return out;
})();

// ---------- 2. the world: two follow slots, over a streamed world -----------
const world = await (async () => {
  const page = await newPage(browser, { width: 960, height: 600 });
  logPageErrors(page);
  // The dev server hot-reloads the page whenever anything under src/ is saved,
  // which silently wipes the in-page collector mid-run. Notice it and start
  // over rather than reporting a truncated sample as if it were a whole one.
  let reloaded = false;
  page.on("framenavigated", (fr) => {
    if (fr === page.mainFrame()) {
      reloaded = true;
    }
  });

  for (let attempt = 1; attempt <= 4; attempt++) {
    reloaded = false;
    await page.goto(`${HOST}/?fps=0&menu=0&vol=0`, { waitUntil: "load", timeout: 60000 });
    await page.waitForSelector("canvas", { timeout: 30000 });
    await page.waitForFunction('typeof __dbgBeastAnim === "function"', { timeout: 15000 });
    await page.waitForFunction("__dbgBeastAnim().length > 0", { timeout: 20000 });
    reloaded = false;
    // BOND A PARTY FIRST. A new game starts with none (see the roster note in
    // tools/suite/roster.mjs — every module bonds its own), and an unbonded
    // roster is fifteen actors parked in reserve at moveSpeed 0: the run still
    // samples four thousand frames and every delta in it is 0.000, which reads
    // as a pass and measures nothing. Same call the suite harness makes.
    await page.evaluate(() => window.__dbgGrantBeast("all"));
    // The world half cannot burst its soak: __dbgAdvance drives the hero's own
    // simulate(), and this measurement is about what a RENDERED frame does.
    await wait(soak * 1000);
    await installChecker(page, SLOW_FRAME_MS);

    // Start a rAF collector and return immediately: a page.evaluate that stays
    // alive for the whole sample dies the moment the renderer hiccups.
    await page.evaluate((sampleMs) => {
      let prevT = performance.now();
      let hops = 0;
      const start = prevT;
      const step = () => {
        const now = performance.now();
        const el = now - start;
        // Provoke the spike: shove the hero to a fresh column every 1.2 s so
        // the beasts alternate between arriving (moveSpeed -> 0) and full
        // catch-up (moveSpeed -> 1). Same cadence as the stage's `jump`.
        if (el > hops * 1200) {
          hops++;
          const a = hops * 1.7;
          window.__dbgTp(Math.cos(a) * 14, Math.sin(a) * 14);
        }
        window.__anim.fold(now - prevT);
        prevT = now;
        if (el < sampleMs) {
          requestAnimationFrame(step);
        } else {
          window.__anim.done = true;
        }
      };
      requestAnimationFrame(step);
    }, SAMPLE_MS);

    // Rotate the roster while the collector runs, so more than the starting
    // pair gets a turn as an actually-moving follower. The stage half is what
    // guarantees the whole roster is seen; this is here so the world half is
    // not permanently measuring the same two.
    await page.focus("canvas").catch(() => {});
    for (let i = 0; i < Math.floor(SAMPLE_MS / 1600) && !reloaded; i++) {
      await wait(1600);
      await page.keyboard.press(i % 2 === 0 ? "BracketRight" : "BracketLeft");
    }
    if (!reloaded) {
      await wait(2000);
    }
    if (reloaded) {
      console.log(`attempt ${attempt}: page reloaded mid-sample, retrying`);
      continue;
    }
    const out = await page.evaluate(() => window.__anim.read());
    await page.close();
    return out;
  }
  await page.close();
  return null;
})();

if (!world) {
  console.error("could not complete a world sample without a reload");
  process.exit(1);
}

// ---------- report ----------------------------------------------------------
const f = (n) => n.toFixed(3);
const report = (name, r) => {
  console.log(
    `\n=== ${name} — ${r.moving}/${r.perBeast.length} species moved, ` +
      `clock ${f(r.elapsed)} s over ${r.frames} frames` +
      `${r.skipped ? `, ${r.skipped} dropped as slow` : ""}` +
      `${r.wallMs !== undefined ? `, ${(r.wallMs / 1000).toFixed(1)} s wall` : ""}`,
  );
  console.log("  worst per-frame rotation delta, by beast:");
  for (const b of r.perBeast) {
    console.log(
      `    ${b.joint.padEnd(30)} ${f(b.d).padStart(9)} rad   ` +
        `(${b.action}, ms=${f(b.ms)}, clock=${f(b.t)}s)`,
    );
  }
};
report("stage", stage);
report("world", world);

for (const [name, r] of [
  ["stage", stage],
  ["world", world],
]) {
  if (!r.frames) {
    fails.push(`${name}: no frames sampled`);
    continue;
  }
  if (!r.moving) {
    fails.push(`${name}: no beast moved at all — the sample is empty`);
    continue;
  }
  const worst = r.top[0];
  if (worst && worst.d > MAX_DELTA) {
    fails.push(
      `${name}: ${worst.joint} jumped ${f(worst.d)} rad in one frame ` +
        `(budget ${MAX_DELTA}, action ${worst.action}, moveSpeed ${f(worst.ms)})`,
    );
  }
}
// THE COVERAGE CLAIM, and the reason the stage half was written: every species
// on the stage is a follower, so every species must have moved. A roster that
// grows without this run seeing it is the hole the old file had, and this is
// the line that now fails instead of quietly under-reporting.
if (stage.moving < stage.perBeast.length) {
  fails.push(
    `stage: only ${stage.moving} of ${stage.perBeast.length} species moved — ` +
      "every species on the stage should be in catch-up follow",
  );
}

console.log(
  `\n${JSON.stringify({
    stage: {
      maxDelta: stage.top[0]?.d ?? 0,
      joint: stage.top[0]?.joint ?? null,
      moving: stage.moving,
    },
    world: {
      maxDelta: world.top[0]?.d ?? 0,
      joint: world.top[0]?.joint ?? null,
      moving: world.moving,
    },
    budget: MAX_DELTA,
    pass: fails.length === 0,
  })}`,
);

await browser.close();

if (fails.length) {
  console.error(`\nFAIL:\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
console.log("\nOK");
