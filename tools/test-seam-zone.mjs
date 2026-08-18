// THE SEAM (game-story.md §4): Act 4's arena is a zone, and a place the hero can
// stand in, swim in and not fall out of.
//
// Usage: bun tools/test-seam-zone.mjs      (dev server must be up)
//
// Six claims, each measured off the running world through `/zone seam`:
//
//   1. THE ZONE EXISTS AND RECEIVES: `/zone seam` lands the hero in it and the
//      whole 5x5 footprint streams in.
//   2. HE STANDS ON THE DISC at the gate spot: his feet within 0.5 of
//      `getHeight` there, and what is DRAWN there is what he stands on
//      (`__dbgSurfaceY`'s sink), so the mesher and the height field agree.
//   3. THREE SECTORS CLASSIFY: `seamSites()` names the middle of each — the
//      meadow is dry turf at ~12, the tide bowl is water with at least 1.5 units
//      under the surface, the cloud deck stands at 15 or more.
//   4. THE RIM HOLDS: a held W toward the edge for four simulated seconds walks
//      him OUT toward the balustrade and STOPS him inside the disc — both halves,
//      so a mis-aimed walk cannot pass as a stop.
//   5. THE ENGINE'S STANDING SPOT IS CLEAR of the machine's own colliders, and
//      the machine itself is solid a few units behind it.
//   6. `/zone overworld` brings him back.
//
// Exits non-zero on failure.
import { launchBrowser, newPage, wait } from "./browser.mjs";
import { BASE as HOST, NO_WARMUP } from "./target.mjs";

// `debug=1` for the console: `/zone` is how this reaches the arena without the gateway.
const URL = `${HOST}/?menu=0&fs=0&vol=0&debug=1&${NO_WARMUP}`;
/** The disc's radius and the walkway's, in world units — world/seam.ts. */
const DISC_R = 72;
const RIM_R = 64;
const WATER_LEVEL = 8;

const browser = await launchBrowser();
const results = {};
const fails = [];
const check = (ok, msg) => {
  if (!ok) {
    fails.push(msg);
  }
};

const page = await newPage(browser, { width: 1280, height: 800 });
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__dbgBoot?.().playing && window.__dbgAdvance, {
  timeout: 90000,
});
await wait(400);

const dbg = (fn, ...args) => page.evaluate(fn, ...args);
const adv = (s) => dbg((n) => window.__dbgAdvance(n), s);
const zone = () => dbg(() => window.__dbgZone());
const pos = () => dbg(() => window.__dbgPlayerPos());
const surface = (x, z) => dbg(([a, b]) => window.__dbgSurfaceY(a, b), [x, z]);
const at = (x, z) => dbg(([a, b]) => window.__dbgWorld(a, b), [x, z]);
const streamed = async () => {
  for (let i = 0; i < 80 && (await dbg(() => window.__dbgZone().streaming)); i++) {
    await wait(250);
  }
};
/** One console line, the way test-orrery drives it. */
async function cmd(line) {
  await page.keyboard.press("Backquote");
  await page.waitForSelector(".bs-console-input", { visible: true });
  await page.type(".bs-console-input", line);
  await page.keyboard.press("Enter");
  await wait(300);
  await page.keyboard.press("Backquote");
  await wait(150);
}
/** The sites, from the module itself: derived, never copied here. */
const sites = () =>
  dbg(async () => {
    const { seamSites, SEAM_ORIGIN_X, SEAM_ORIGIN_Z } = await import("/src/world/seam.ts");
    return { ...seamSites(), ox: SEAM_ORIGIN_X, oz: SEAM_ORIGIN_Z };
  });

// ---------- 1. the zone ------------------------------------------------------
const t0 = Date.now();
await cmd("/zone seam");
await streamed();
await adv(0.5);
{
  const z = await zone();
  results.enter = { ms: Date.now() - t0, id: z.id, chunks: z.chunksLoaded, streaming: z.streaming };
  check(z.id === "seam", `the console did not reach the seam (in "${z.id}")`);
  check(z.chunksLoaded === 25, `the seam streamed ${z.chunksLoaded} chunks, not its whole 5x5 footprint`);
}

// ---------- 2. standing at the gate --------------------------------------------
const S = await sites();
const C = { x: S.ox + 80, z: S.oz + 80 };
{
  const p = await pos();
  const g = await surface(p.x, p.z);
  // The return arch stands ON the gate spot, so the drawn-vs-stood check reads the meadow beside it.
  const m = await surface(S.land.x, S.land.z);
  results.gate = { hero: p, gate: S.gate, ground: g.ground, meadowDrawn: m.surface, meadowSink: m.sink };
  check(Math.hypot(p.x - S.gate.x, p.z - S.gate.z) < 1.5, "the hero did not arrive on the gate spot");
  check(Math.abs(p.y - g.ground) < 0.5, `the hero stands at y=${p.y}, the ground is ${g.ground}`);
  check(m.surface !== null && Math.abs(m.sink) < 0.15, `what is drawn on the meadow is ${m.sink} off the walking surface`);
}

// ---------- 3. the sectors -----------------------------------------------------
{
  const land = await at(S.land.x, S.land.z);
  const sea = await at(S.sea.x, S.sea.z);
  const sky = await at(S.sky.x, S.sky.z);
  const seaGround = (await surface(S.sea.x, S.sea.z)).ground;
  results.sectors = { land, sea, sky, seaGround };
  check(!land.water && Math.abs(land.ground - 12) <= 1.5, `the meadow's middle is not dry turf near 12 (${JSON.stringify(land)})`);
  check(sea.water, "the tide bowl's middle is not water");
  check(WATER_LEVEL - seaGround >= 1.5, `the bowl is ${(WATER_LEVEL - seaGround).toFixed(2)} deep at its middle — not a swim`);
  check(sky.ground >= 15 && !sky.water, `the cloud deck's middle stands at ${sky.ground}`);
}

// ---------- 4. the rim holds -----------------------------------------------------
{
  // From the walkway's inner edge, straight out along the meadow's bearing (-z).
  const startX = C.x;
  const startZ = C.z - (RIM_R - 2);
  const bearing = Math.PI;
  await dbg(([x, z, b]) => {
    window.__dbgTp(x, z);
    window.__dbgAim(b);
  }, [startX, startZ, bearing]);
  await adv(1.0);
  const before = await pos();
  await page.keyboard.down("KeyW");
  await adv(4);
  await page.keyboard.up("KeyW");
  const after = await pos();
  const r0 = Math.hypot(before.x - C.x, before.z - C.z);
  const r1 = Math.hypot(after.x - C.x, after.z - C.z);
  results.rim = {
    start: { r: +r0.toFixed(2), y: before.y },
    end: { r: +r1.toFixed(2), y: after.y },
    walked: +Math.hypot(after.x - before.x, after.z - before.z).toFixed(2),
  };
  // Four seconds of walking is ~24 units: unblocked he would be well past 72.
  check(r1 > r0 + 3, `the walk did not head out toward the rim (r ${r0.toFixed(1)} -> ${r1.toFixed(1)})`);
  check(r1 < DISC_R - 1, `the hero walked to r=${r1.toFixed(2)} — through the balustrade`);
  check(after.y > 11, `the hero fell to y=${after.y} at the rim`);
}

// ---------- 5. the engine's standing spot ------------------------------------------
{
  const stand = await at(S.engine.x, S.engine.z);
  const machine = await at(S.engine.x, S.engine.z + 5);
  results.engine = { stand, machine };
  check(
    stand.structureTop === null || stand.structureTop === -Infinity || stand.structureTop <= stand.ground + 0.5,
    `the standing spot is inside the machine (structure top ${stand.structureTop})`,
  );
  check(machine.structureTop > machine.ground + 3, `the machine is not solid behind the lever (top ${machine.structureTop})`);
}

// ---------- 6. and back --------------------------------------------------------------
{
  await cmd("/zone overworld");
  await streamed();
  await adv(0.5);
  const z = await zone();
  results.back = { id: z.id };
  check(z.id === "overworld", `the console did not bring the hero back (in "${z.id}")`);
}

console.log(JSON.stringify({ ...results, failures: fails, pass: fails.length === 0 }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
