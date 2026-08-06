// Verifies the DEEP SEA (issue #76) by driving bodies at it, not by reasoning
// about the maths.
//
// Usage: bun tools/test-deepwater.mjs        (dev server must be up)
//        ...or as sections inside `bun tools/suite.mjs` — same code either way.
//
// FAST-FORWARDED, SHARED-SESSION: every hold and settle is simulated time
// drained through `__dbgAdvance` (see tools/suite/harness.mjs), so the 6-second
// key holds cost tenths of a second and the boot is the suite's, paid once.
// Measured real-time before the conversion: 58.8 s.
//
// The feature is one rule seen from four sides, and every section here is the
// same experiment with a different body under it: aim along a bearing, put the
// body a few units back along it, hold W, read where it stopped.
//
//   1. the world HAS a deep sea, and `deep` is a strict subset of `water`
//   2. a swimmer is turned back at its edge — and swims freely in the shallows,
//      which is the other half of that pair and the only thing that makes the
//      first half mean anything
//   3. a GROUND mount is turned back too
//   4. a WATER mount crosses — and is faster afloat than ashore
//
// EVERY COORDINATE IS DERIVED. `__dbgWorld(x, z).deep` is asked for the real
// basin nearest the spawn and the real beach nearest that basin, so the test
// follows the seed's coastline instead of pinning a set of numbers to it. The
// threshold itself is never written down here — that number belongs to
// world/terrain.ts (DEEP_WATER_DEPTH), and a probe that hard-coded it would go
// on passing after the rule changed.
//
// Exits non-zero on failure.

/**
 * How long a movement key is held per case, in SIMULATED seconds.
 *
 * 6 s. A swimmer makes 4.2 u/s and a mounted Finnick 21.8, so this is the hold
 * that lets the SLOWEST body in the test cross the shallow band and reach the
 * edge of the basin — and the fastest one is then given the same hold, which is
 * what makes "it stopped" and "it crossed" the same measurement.
 */
const HOLD_S = 6;
/** How far back from the waterline a mounted run starts, so it has runway. */
const RUNWAY = 6;

const round = (v, n = 2) => +v.toFixed(n);
const bearing = (fromX, fromZ, toX, toZ) => Math.atan2(toX - fromX, toZ - fromZ);

/** Set by the geometry section; read by every run after it. */
let geom = null;
let yaw = 0;
let inland = 0;
let ux = 0;
let uz = 0;

/** A launch point `d` units from the shore column along the bearing to the deep. */
const along = (d) => [geom.shore.x + ux * d, geom.shore.z + uz * d];

/** Aim, place, hold W for `holdS` SIMULATED seconds, report the run's ends. */
async function drive(ctx, startX, startZ, heading, holdS = HOLD_S) {
  await ctx.ev(([x, z, y]) => { window.__dbgTp(x, z); window.__dbgAim(y); },
    [startX, startZ, heading]);
  // The camera's forward comes from its SMOOTHED position, so a big swing needs
  // most of a second to arrive; pressing W before it does drives off along the
  // old heading. Same settle, and the same reason, as tools/test-structures.mjs
  // — but simulated now, not slept.
  await ctx.adv(0.9);
  await ctx.ev(([x, z, y]) => { window.__dbgTp(x, z); window.__dbgAim(y); },
    [startX, startZ, heading]);
  await ctx.adv(0.4);
  const before = await ctx.ev(() => window.__dbgPlayerPos());
  await ctx.page.keyboard.down('KeyW');
  // Sampled rather than merely timed, so a run can report the fastest it ever
  // went and on what — which is what the speed assertion measures and what a
  // start/end pair cannot see.
  //
  // ONE `evaluate` PER SAMPLE, and that is not tidiness. Reading the position,
  // the column under it and the mount's speed as three round-trips lets a
  // sample be assembled out of three different moments, and a mounted Finnick
  // covers five units between them — so a batched run reported a mount doing
  // 20.46 u/s "on land", which is the water speed wearing the land sample's
  // coordinates. Inside one evaluate no frame can run between the three reads.
  const samples = [];
  const steps = Math.max(1, Math.round(holdS / 0.25));
  for (let i = 0; i < steps; i++) {
    await ctx.adv(0.25);
    samples.push(await ctx.ev(() => {
      const p = window.__dbgPlayerPos();
      const w = window.__dbgWorld(p.x, p.z);
      return { x: p.x, z: p.z, water: w.water, deep: w.deep, speed: window.__dbgMount().speed };
    }));
  }
  await ctx.page.keyboard.up('KeyW');
  await ctx.adv(0.25);
  const after = await ctx.ev(() => window.__dbgPlayerPos());
  const end = await ctx.ev(([x, z]) => window.__dbgWorld(x, z), [after.x, after.z]);
  return {
    start: { x: round(before.x), z: round(before.z) },
    end: { x: round(after.x), z: round(after.z) },
    travelled: round(Math.hypot(after.x - before.x, after.z - before.z)),
    endedDeep: end.deep,
    endedInWater: end.water,
    /** Did it EVER stand in a deep column, not just finish in one? */
    everDeep: samples.some((s) => s.deep),
    everWater: samples.some((s) => s.water),
    topSpeedOnWater: round(Math.max(0, ...samples.filter((s) => s.water).map((s) => s.speed))),
    topSpeedOnLand: round(Math.max(0, ...samples.filter((s) => !s.water).map((s) => s.speed))),
  };
}

export const name = 'deepwater';
export const sections = [

  // -------------------------------------------------------------------------
  { id: 'survey', run: async (ctx) => {
    // THE WORLD HAS A DEEP SEA, AND IT IS A SUBSET OF THE WATER. Sampled over a
    // 400-unit box around the spawn on a 2-unit lattice. The fraction is
    // asserted as a BAND rather than a floor: too little and the rule has
    // nowhere to apply (which is what the terrain looked like before the abyss
    // term — 0.8% of the map five units down), too much and the shallows have
    // stopped being a place you can swim.
    const survey = await ctx.ev(() => {
      const s = window.__dbgTowns().spawn;
      let cols = 0; let water = 0; let deep = 0; let deepButDry = 0; let worstTop = -Infinity;
      for (let dx = -200; dx <= 200; dx += 2) {
        for (let dz = -200; dz <= 200; dz += 2) {
          const w = window.__dbgWorld(s.x + dx, s.z + dz);
          cols++;
          if (w.water) water++;
          if (w.deep) {
            deep++;
            if (!w.water) deepButDry++;
            if (w.ground > worstTop) worstTop = w.ground;
          }
        }
      }
      return { cols, water, deep, deepButDry, worstTop };
    });
    ctx.res.survey = {
      ...survey,
      waterPct: round((100 * survey.water) / survey.cols, 1),
      deepPct: round((100 * survey.deep) / survey.cols, 1),
      deepOfWaterPct: round((100 * survey.deep) / Math.max(1, survey.water), 1),
    };
    ctx.check(survey.deep > 0, 'there is no deep water anywhere near the spawn');
    ctx.check(ctx.res.survey.deepPct >= 1.5,
      `the deep sea is a rounding error: ${ctx.res.survey.deepPct}% of the map`);
    ctx.check(ctx.res.survey.deepOfWaterPct <= 75,
      `the deep sea has eaten the shallows: ${ctx.res.survey.deepOfWaterPct}% of all water`);
    ctx.check(survey.deepButDry === 0,
      `${survey.deepButDry} columns report deep but not water — deep must imply wet`);
  } },

  // -------------------------------------------------------------------------
  { id: 'geometry', run: async (ctx) => {
    // The nearest basin, and the beach nearest to it.
    geom = await ctx.ev(() => {
      const s = window.__dbgTowns().spawn;
      let deep = null; let dbest = Infinity;
      for (let dx = -220; dx <= 220; dx += 2) {
        for (let dz = -220; dz <= 220; dz += 2) {
          if (!window.__dbgWorld(s.x + dx, s.z + dz).deep) continue;
          const d = dx * dx + dz * dz;
          if (d < dbest) { dbest = d; deep = { x: s.x + dx, z: s.z + dz }; }
        }
      }
      if (!deep) return null;
      // The nearest DRY column to that basin: where a rider starts.
      let shore = null; let sbest = Infinity;
      for (let dx = -100; dx <= 100; dx++) {
        for (let dz = -100; dz <= 100; dz++) {
          const w = window.__dbgWorld(deep.x + dx, deep.z + dz);
          if (w.water) continue;
          const d = dx * dx + dz * dz;
          if (d < sbest) { sbest = d; shore = { x: deep.x + dx, z: deep.z + dz, ground: w.ground }; }
        }
      }
      return { deep, shore, shoreToDeep: Math.sqrt(sbest) };
    });
    ctx.check(!!geom, 'no deep water found near spawn');
    if (!geom) throw new Error('no geometry to drive at');
    yaw = bearing(geom.shore.x, geom.shore.z, geom.deep.x, geom.deep.z);
    // Away from the basin — the control heading, and the mounted run's start.
    inland = yaw + Math.PI;
    // The unit step along the bearing, so a launch point can be placed at a
    // distance along it. `bearing` is atan2(dx, dz), so x takes the SIN.
    ux = Math.sin(yaw); uz = Math.cos(yaw);
    ctx.res.geometry = {
      deep: geom.deep,
      shore: { x: geom.shore.x, z: geom.shore.z, ground: round(geom.shore.ground) },
      shoreToDeep: round(geom.shoreToDeep),
      yawDeg: round((yaw * 180) / Math.PI, 1),
    };
    ctx.check(geom.shoreToDeep < 60,
      `the nearest basin is ${round(geom.shoreToDeep)} units off its own beach — too far to drive`);
  } },

  // -------------------------------------------------------------------------
  { id: 'onFoot', run: async (ctx) => {
    // ON FOOT: TURNED BACK AT THE EDGE, AND FREE IN THE SHALLOWS. Both halves,
    // because "he did not reach the deep water" on its own is equally
    // consistent with a hero who cannot swim at all.
    const [wx, wz] = along(Math.min(4, geom.shoreToDeep * 0.4));
    await ctx.ev(() => window.__dbgRide('off'));
    const toward = await drive(ctx, wx, wz, yaw);
    const back = await drive(ctx, wx, wz, inland);
    ctx.res.onFoot = { toward, control: back };
    ctx.check(!toward.everDeep,
      `a swimmer got into deep water and ended at ${JSON.stringify(toward.end)}`);
    ctx.check(back.travelled > 5,
      `the control swim went nowhere (${back.travelled} units) — the refusal above proves nothing`);
  } },

  // -------------------------------------------------------------------------
  { id: 'groundMount', run: async (ctx) => {
    // A GROUND MOUNT IS TURNED BACK TOO.
    const [bx, bz] = along(-RUNWAY);
    await ctx.ev(() => window.__dbgRide('off'));
    await ctx.tp(bx, bz);
    await ctx.adv(0.6);
    const said = await ctx.ev(() => window.__dbgRide('boulderpup'));
    const m = await ctx.ev(() => window.__dbgMount());
    const run = await drive(ctx, bx, bz, yaw);
    ctx.res.groundMount = { said, locomotion: m.locomotion, run };
    ctx.check(m.mounted && m.beast === 'boulderpup', `could not ride Boulderpup: ${said}`);
    ctx.check(!run.everDeep,
      `a ground mount crossed the deep sea and ended at ${JSON.stringify(run.end)}`);
  } },

  // -------------------------------------------------------------------------
  { id: 'waterMount', run: async (ctx) => {
    // A WATER MOUNT CROSSES — AND IS TRANSFORMED BY THE WATER.
    const [bx, bz] = along(-RUNWAY);
    await ctx.ev(() => window.__dbgRide('off'));
    await ctx.tp(bx, bz);
    await ctx.adv(0.6);
    const said = await ctx.ev(() => window.__dbgRide('finnick'));
    const m = await ctx.ev(() => window.__dbgMount());
    // The LAND leg first, driven away from the water so it never touches any.
    // Two runs rather than one, and the reason is the waterline: the rider sits
    // SEAT_BACK behind the mount (player/mount.ts), so the column this samples
    // is his and not the animal's, and for a slice or two at the water's edge
    // the mount is already swimming while the rider is still over sand.
    // Measuring the two speeds on two runs that never go near each other's
    // medium removes the boundary from the experiment instead of trying to
    // sample across it.
    const landRun = await drive(ctx, bx, bz, inland, 4);
    // Back to the launch point for the crossing. `__dbgTp` moves the saddle as
    // well as the rider (MountController.teleport), so this is one call and not
    // a dismount-and-remount dance — but the crossing only means what it says
    // if it STARTS where the land leg did, so the placement is read back and
    // asserted rather than assumed. It was assumed once, and the run began 26
    // units away.
    await ctx.tp(bx, bz);
    await ctx.adv(0.6);
    const replaced = await ctx.ev(() => window.__dbgPlayerPos());
    const run = await drive(ctx, bx, bz, yaw);
    ctx.check(Math.hypot(replaced.x - bx, replaced.z - bz) < 3,
      `the mounted teleport did not take: asked for (${round(bx)}, ${round(bz)}), `
      + `got (${round(replaced.x)}, ${round(replaced.z)})`);
    ctx.res.waterMount = { said, locomotion: m.locomotion, landRun, run };
    ctx.check(m.mounted && m.beast === 'finnick', `could not ride Finnick: ${said}`);
    ctx.check(run.everDeep,
      `a water mount could not cross the deep sea: ended at ${JSON.stringify(run.end)}, `
      + `${run.travelled} units from a start ${round(geom.shoreToDeep + RUNWAY)} from the basin`);
    ctx.check(landRun.topSpeedOnLand > 4,
      `the land leg never got going (${landRun.topSpeedOnLand} u/s) — the comparison below `
      + 'would pass on a mount that was simply stuck');
    // SWIM_GALLOP is 3.2 against a land gallop of 1.85 * LAND_FLOP 0.55, i.e.
    // 3.1x on paper; 1.8 leaves room for a land leg that met a hill and for the
    // acceleration ramp at either end.
    ctx.check(run.topSpeedOnWater > landRun.topSpeedOnLand * 1.8,
      `the water mount is not faster in water: ${run.topSpeedOnWater} u/s afloat against `
      + `${landRun.topSpeedOnLand} on land`);
    await ctx.ev(() => window.__dbgRide('off'));
  } },
];

if (import.meta.main) {
  const { soloRun } = await import('./suite/harness.mjs');
  await soloRun({ name, sections });
}
