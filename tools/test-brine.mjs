// THE BRINE REACH IS PART OF THE OPEN WORLD (issue #144, decided in review of
// the zone-based first cut of #227): seaward of Embervale's coastline the
// landform blends into an island sea, Saltrest stands on an island in it, and
// the first crossing is the FERRY — a scripted sail between two piers of the
// SAME world. No zone, no instance, no teleport-arch.
//
// Usage: bun tools/test-brine.mjs      (dev server must be up)
//
// Five claims:
//
//   1. EMBERVALE IS BIT-IDENTICAL. The coastline blend starts at SEA_START 340
//      along SEA_DIR, past everything the overworld builds; six pinned heights
//      — spawn country, both landmark pads, the far towns — must equal the
//      values read from main@1c1647e with `new Terrain(1337)` headlessly.
//   2. THE SEA REGION IS A SEA: past SEA_FULL the reach measures mostly water,
//      and a good share of it the dark kind (bed <= DEEP_WATER_TOP) — the
//      unswimmable grammar the act teaches against, measured off the
//      heightfield, not read off a flag.
//   3. SALTREST STANDS ON AN ISLAND: in the town registry, kind `harbour`, dry
//      at its centre, past the coastline, with open water in reach of its ring.
//   4. THE FERRY IS MOORED BY `sea-revealed` — both halves: before the flag the
//      boats are absent and a press on the pier moves nobody; after it they are
//      moored and the press SAILS, landing the hero at Saltrest's quay.
//   5. THE WAY HOME WORKS: the quay pad is disarmed until walked off (the
//      landing-pad rule), then a press sails back to Embervale's pier.
//
// Exits non-zero on failure.
import { launchBrowser, newPage, wait } from "./browser.mjs";
import { BASE as HOST, NO_WARMUP } from "./target.mjs";

const URL = `${HOST}/?menu=0&fs=0&vol=0&${NO_WARMUP}`;

/** Terrain constants, quoted from src/world/terrain.ts — the probe measures against them. */
const SEA_DIR = { x: 0.404, z: 0.915 };
const SEA_FULL = 720;
const WATER = 8;
const DEEP_TOP = 4;

/** Embervale reference heights, read from main@1c1647e via `new Terrain(1337).heightCont`. */
const PINNED = [
  [0, 0, 8.2413],
  [111, 3, 14.5684],
  [280, 23, 15.449],
  [-551, -443, 16.7018],
  [879, -255, 10.7936],
  [216, 241, 9.8832],
];

/** How long one sail may take — fade, move, and the far quay streaming in. */
const SAIL_TIMEOUT = 45000;

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
await page.waitForFunction(() => window.__dbgBoot && window.__dbgBoot().playing, {
  timeout: 90000,
});
await wait(400);

const dbg = (fn, ...args) => page.evaluate(fn, ...args);
const ferry = () => dbg(() => window.__dbgFerry());
const pos = () => dbg(() => window.__dbgPlayerPos());
const tp = (x, z) => dbg((p) => window.__dbgTp(p.x, p.z), { x, z });

// ---------- 1. Embervale is bit-identical ------------------------------------
{
  // A FRESH Terrain, not the world's: the world query answers stepped columns with
  // flatten discs and road carves in; the pinned values are the raw field, so the
  // comparison must be raw field against raw field.
  const got = await dbg(async (pts) => {
    const { Terrain } = await import("/src/world/terrain.ts");
    const t = new Terrain(1337);
    return pts.map(([x, z]) => t.heightCont(x, z));
  }, PINNED);
  const drift = PINNED.map(([x, z, want], i) => ({ x, z, want, got: got[i] })).filter(
    (p) => Math.abs(p.got - p.want) > 0.0005,
  );
  results.embervale = { pinned: PINNED.length, drift };
  check(drift.length === 0, `Embervale moved under the blend: ${JSON.stringify(drift)}`);
}

// ---------- 2. the sea region is a sea ---------------------------------------
{
  const sea = await dbg(
    (c) => {
      let wet = 0;
      let deep = 0;
      let n = 0;
      // Discs down the lobe axis, sampled on rings — the water the ferry crosses
      // and the islands' surroundings, well past the blend band.
      for (const along of [900, 1150, 1400, 1700]) {
        const ax = c.SEA_DIR.x * along;
        const az = c.SEA_DIR.z * along;
        for (const r of [0, 60, 130]) {
          for (let k = 0; k < 12; k++) {
            const a = (k / 12) * Math.PI * 2;
            const h = window.__dbgSurfaceY(ax + Math.cos(a) * r, az + Math.sin(a) * r).ground;
            n++;
            if (h < c.WATER) {
              wet++;
            }
            if (h <= c.DEEP_TOP) {
              deep++;
            }
          }
        }
      }
      return { wet: wet / n, deep: deep / n, n };
    },
    { SEA_DIR, WATER, DEEP_TOP },
  );
  results.sea = { wet: +sea.wet.toFixed(2), deep: +sea.deep.toFixed(2), samples: sea.n };
  check(sea.wet > 0.5, `only ${(sea.wet * 100).toFixed(0)}% of the reach is water — not an island sea`);
  check(sea.deep > 0.25, `only ${(sea.deep * 100).toFixed(0)}% is the dark water — the channels are puddles`);
}

// ---------- 3. Saltrest stands on an island ----------------------------------
let saltrest;
{
  const towns = (await dbg(() => window.__dbgTowns().towns)) ?? [];
  saltrest = towns.find((t) => t.id === "saltrest");
  results.saltrest = saltrest ?? null;
  check(!!saltrest, "town:saltrest is not in the world registry");
  if (saltrest) {
    check(saltrest.kind === "harbour", `saltrest is a "${saltrest.kind}", not a harbour`);
    const proj = saltrest.x * SEA_DIR.x + saltrest.z * SEA_DIR.z;
    check(proj > SEA_FULL, `saltrest stands at d=${proj.toFixed(0)}, inside the coastline blend`);
    const isle = await dbg(
      (s) => {
        const centre = window.__dbgSurfaceY(s.x, s.z).ground;
        let wet = 0;
        let n = 0;
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2;
          for (const r of [s.radius * 2.5, s.radius * 4]) {
            n++;
            if (window.__dbgSurfaceY(s.x + Math.cos(a) * r, s.z + Math.sin(a) * r).ground < 8) {
              wet++;
            }
          }
        }
        return { centre, wet: wet / n };
      },
      saltrest,
    );
    results.saltrestIsle = { centre: +isle.centre.toFixed(2), wet: +isle.wet.toFixed(2) };
    check(isle.centre >= WATER, `saltrest's centre is under water (${isle.centre.toFixed(1)})`);
    check(isle.wet > 0.25, `no sea around saltrest (${(isle.wet * 100).toFixed(0)}% wet) — not an island`);
  }
}

// ---------- 4. the ferry is moored by `sea-revealed`, both halves ------------
let pier;
{
  const before = await ferry();
  check(before.present === true, "the ferry system did not construct");
  check(before.enabled === false, "the boats are moored before sea-revealed is set");
  pier = before.stops?.find((s) => s.id === "pier");
  check(!!pier, "no Embervale pier stop");
  if (pier) {
    await tp(pier.x, pier.z);
    await wait(600);
    await page.keyboard.press("KeyE");
    await wait(800);
    const after = await ferry();
    const p = await pos();
    const moved = Math.hypot(p.x - pier.x, p.z - pier.z);
    results.sealed = { sailing: after.sailing, moved: +moved.toFixed(2) };
    check(after.sailing === null && moved < 4, "a press on the pier sailed before the act opened");
  }
}

async function sailFrom(stop, wantNearId) {
  await tp(stop.x, stop.z);
  await wait(600);
  await page.keyboard.press("KeyE");
  const t0 = Date.now();
  for (;;) {
    await wait(250);
    const f = await ferry();
    if (f.sailing === null && Date.now() - t0 > 1500) {
      break;
    }
    if (Date.now() - t0 > SAIL_TIMEOUT) {
      return null;
    }
  }
  const f = await ferry();
  const want = f.stops.find((s) => s.id === wantNearId);
  const p = await pos();
  return { ms: Date.now() - t0, d: Math.hypot(p.x - want.x, p.z - want.z), want };
}

let quay;
{
  await dbg(async () => {
    const { content } = await import("/src/content/index.ts");
    content.state.setFlag("sea-revealed", true);
  });
  await wait(400);
  const f = await ferry();
  quay = f.stops.find((s) => s.id === "saltrest");
  results.moored = { enabled: f.enabled, boats: f.stops.map((s) => s.boatVisible) };
  check(f.enabled === true, "sea-revealed did not moor the boats");
  check(f.stops.every((s) => s.boatVisible), "a boat is missing from its pier");

  const out = await sailFrom(pier, "saltrest");
  results.out = out && { ms: out.ms, d: +out.d.toFixed(2) };
  check(out !== null, `the sail never finished in ${SAIL_TIMEOUT / 1000}s`);
  if (out) {
    check(out.d < 6, `the sail landed ${out.d.toFixed(1)} from Saltrest's quay`);
  }

  // THE LANDING PAD IS DISARMED — asked NOW, standing where the sail put us,
  // before anything walks away and re-arms it (the gateway's landing-pad rule).
  await page.keyboard.press("KeyE");
  await wait(800);
  const bounced = await ferry();
  results.landingPad = { sailing: bounced.sailing };
  check(bounced.sailing === null, "a press on the pad the hero landed on sailed him straight back");

  // Walk INTO the town so town-arrival and discovery fire — the quay is on the rim.
  if (saltrest) {
    await tp(saltrest.x, saltrest.z);
    await wait(800);
    const seen = await dbg(async () => {
      const { content } = await import("/src/content/index.ts");
      return {
        town: content.state.discovered("town:saltrest"),
        region: content.state.discovered("region:brine"),
      };
    });
    results.discovered = seen;
    check(seen.town === true, "walking into Saltrest did not discover it");
    check(seen.region === true, "the first landfall did not discover region:brine");
  }
}

// ---------- 5. and the way home ----------------------------------------------
{
  // Walk off to arm the quay pad, then sail home.
  await tp(quay.x + 10, quay.z + 10);
  await wait(600);
  const back = await sailFrom(quay, "pier");
  results.back = back && { ms: back.ms, d: +back.d.toFixed(2) };
  check(back !== null, `the sail home never finished in ${SAIL_TIMEOUT / 1000}s`);
  if (back) {
    check(back.d < 6, `the sail home landed ${back.d.toFixed(1)} from the pier`);
  }
}

console.log(JSON.stringify({ ...results, failures: fails, pass: fails.length === 0 }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
