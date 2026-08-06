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
// ...and two more that are the same water seen from underneath (issue #103):
//
//   5. a WATER mount DIVES on C, is stopped by the bed, comes back up on Space,
//      and can never be pushed above the line it floats at
//   6. a GROUND mount in water it can stand in ignores C entirely
//
// EVERY COORDINATE IS DERIVED. `__dbgWorld(x, z).deep` is asked for the real
// basin nearest the spawn and the real beach nearest that basin, so the test
// follows the seed's coastline instead of pinning a set of numbers to it. The
// threshold itself is never written down here — that number belongs to
// world/terrain.ts (DEEP_WATER_DEPTH), and a probe that hard-coded it would go
// on passing after the rule changed.
//
// Exits non-zero on failure.

import { bondAll } from './suite/harness.mjs';

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

  // A PARTY TO RIDE. Since issue #4 a new game is bonded to nothing, and the
  // sections below ride a Boulderpup and a Finnick by name. See `bondAll`.
  { id: 'party', run: async (ctx) => { await bondAll(ctx); } },

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

  // -------------------------------------------------------------------------
  { id: 'waterMountDive', run: async (ctx) => {
    // A WATER MOUNT GOES UNDER (issue #103) — and comes back.
    //
    // Four facts, one hold each, because they fail independently: C takes the
    // pair down, the bed stops them, Space brings them back up, and the surface
    // is a ceiling rather than a diving board. The last one is why every height
    // here is compared against `float.bodyY` — where the mount settled with
    // nothing held — instead of against `waterLevel` minus a number: the float
    // line is WADE_DEPTH under the surface and that constant belongs to
    // player/mount.ts, so a test that wrote it down would go on passing after it
    // moved. Measuring against the observed float line asks the only question
    // that matters anyway: did it get lower, and did it get back.
    // MOUNTED ASHORE AND CARRIED OUT, in that order and not the other one: a
    // hero standing in the basin is SWIMMING, and mounting refuses a swimmer on
    // purpose (`MountController.refusal`). So the saddle is taken on the dry
    // beach the geometry section found, and `__dbgTp` — which moves the animal
    // too, see MountController.teleport — puts the pair in the deepest water
    // there is, which is the only column deep enough for the bed assertion
    // below to mean anything.
    await ctx.ev(() => window.__dbgRide('off'));
    const [sx, sz] = along(-RUNWAY);
    await ctx.tp(sx, sz);
    await ctx.adv(0.6);
    const said = await ctx.ev(() => window.__dbgRide('finnick'));
    await ctx.tp(geom.deep.x, geom.deep.z);
    await ctx.adv(1.5);
    const bed = await ctx.ev(([x, z]) => window.__dbgWorld(x, z).ground,
      [geom.deep.x, geom.deep.z]);
    const float = await ctx.ev(() => window.__dbgMount());
    ctx.check(float.mounted && float.beast === 'finnick', `could not ride Finnick: ${said}`);
    ctx.check(float.swimming,
      'a mounted Finnick in the deepest basin near spawn does not report swimming');
    ctx.check(float.diveDepth < 0.1,
      `the mount is already under before anything was held (${float.diveDepth} down)`);

    /** Hold `code` for `secs` SIMULATED seconds, sampling the saddle's height. */
    const hold = async (code, secs) => {
      if (code) await ctx.page.keyboard.down(code);
      const track = [];
      let peakRise = 0;
      let last = (await ctx.ev(() => window.__dbgMount())).bodyY;
      for (let i = 0; i < Math.round(secs / 0.25); i++) {
        await ctx.adv(0.25);
        const m = await ctx.ev(() => window.__dbgMount());
        const v = (m.bodyY - last) / 0.25;
        if (v > peakRise) peakRise = v;
        last = m.bodyY;
        track.push({ y: round(m.bodyY), depth: m.diveDepth });
      }
      if (code) await ctx.page.keyboard.up(code);
      return { track, end: track[track.length - 1], peakRise: round(peakRise) };
    };

    // ---- C: down, and the bed catches it -----------------------------------
    const dive = await hold('KeyC', 4);
    // ---- Space: back up, and no further than the float line -----------------
    const rise = await hold('Space', 3);
    // ---- nothing held, from the bottom: it floats, it does not cork ---------
    const sink = await hold('KeyC', 3);
    const bob = await hold(null, 5);

    ctx.res.waterMountDive = {
      floatY: round(float.bodyY), bed: round(bed),
      dive: { end: dive.end, aboveBed: round(dive.end.y - bed) },
      rise: rise.end,
      sank: sink.end,
      bob: { end: bob.end, peakRise: bob.peakRise },
    };

    ctx.check(dive.end.depth > 1.5,
      `holding C did not take the mount down (${dive.end.depth} units under the float line)`);
    ctx.check(dive.end.y >= bed - 0.05,
      `the mount dived THROUGH the bed: ${round(dive.end.y)} against a bed at ${round(bed)}`);
    ctx.check(rise.end.depth < dive.end.depth - 1,
      `holding Space did not bring it back up: ${rise.end.depth} under, from ${dive.end.depth}`);
    // THE SURFACE IS A CEILING. Space is a swim, not a leap out of the water,
    // so no sample from any of the four holds may sit above where it floated.
    const breach = [...dive.track, ...rise.track, ...sink.track, ...bob.track]
      .find((s) => s.y > float.bodyY + 0.05);
    ctx.check(!breach,
      `the mount broke the surface at y=${breach?.y} against a float line of ${round(float.bodyY)}`);
    ctx.check(bob.end.depth < 0.3,
      `it never floated back to the surface with nothing held (${bob.end.depth} under)`);
    // The cork, the mount's half of the same cap the hero needed when he learned
    // to dive (SWIM_RISE_MAX in player/index.ts and again in player/mount.ts):
    // an uncapped buoyancy spring from the bed of a basin surfaces the pair
    // faster than they can swim. 6 sits clear of the 4.5 the cap allows.
    ctx.check(bob.peakRise < 6,
      `it corked to the surface at ${bob.peakRise} units/s — buoyancy is uncapped`);
    await ctx.ev(() => window.__dbgRide('off'));
  } },

  // -------------------------------------------------------------------------
  { id: 'groundMountNoDive', run: async (ctx) => {
    // ...AND A GROUND MOUNT STILL WADES. The other half of the section above and
    // the reason it means anything: "holding C moved it down" would pass on a
    // build where C simply drove every mount into the ground. A Boulderpup in
    // water it is allowed to stand in stays exactly where it is.
    //
    // The column is a SHALLOW one found here rather than the basin, because the
    // basin is the one place a ground mount is refused outright (`deepRefused`)
    // — being turned back at its edge is the `groundMount` section's business,
    // not this one's.
    const shallow = await ctx.ev(([dx, dz]) => {
      let best = null; let dbest = Infinity;
      for (let ox = -60; ox <= 60; ox++) {
        for (let oz = -60; oz <= 60; oz++) {
          const x = dx + ox; const z = dz + oz;
          const w = window.__dbgWorld(x, z);
          if (!w.water || w.deep) continue;
          const d = ox * ox + oz * oz;
          if (d < dbest) { dbest = d; best = { x, z, ground: w.ground }; }
        }
      }
      return best;
    }, [geom.deep.x, geom.deep.z]);
    ctx.check(!!shallow, 'no shallow water near the basin to wade a ground mount into');
    if (!shallow) return;

    // Ashore first, for the same reason as the section above: a hero already in
    // the water cannot climb into a saddle.
    await ctx.ev(() => window.__dbgRide('off'));
    const [sx, sz] = along(-RUNWAY);
    await ctx.tp(sx, sz);
    await ctx.adv(0.6);
    const said = await ctx.ev(() => window.__dbgRide('boulderpup'));
    await ctx.tp(shallow.x, shallow.z);
    await ctx.adv(1.5);
    const before = await ctx.ev(() => window.__dbgMount());
    await ctx.page.keyboard.down('KeyC');
    await ctx.adv(3);
    await ctx.page.keyboard.up('KeyC');
    const after = await ctx.ev(() => window.__dbgMount());
    ctx.res.groundMountNoDive = {
      column: { x: shallow.x, z: shallow.z, ground: round(shallow.ground) },
      before: round(before.bodyY), after: round(after.bodyY), swimming: after.swimming,
    };
    ctx.check(before.mounted && before.beast === 'boulderpup',
      `could not ride Boulderpup: ${said}`);
    ctx.check(!after.swimming, 'a Boulderpup reports swimming — only water beasts swim');
    ctx.check(Math.abs(after.bodyY - before.bodyY) < 0.1,
      `holding C sank a wading ground mount from ${round(before.bodyY)} to ${round(after.bodyY)}`);
    await ctx.ev(() => window.__dbgRide('off'));
  } },
];

if (import.meta.main) {
  const { soloRun } = await import('./suite/harness.mjs');
  await soloRun({ name, sections });
}
