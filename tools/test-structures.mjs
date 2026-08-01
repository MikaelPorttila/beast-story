// Verifies that a settlement's buildings, walls, crates and gate behave — and
// that beasts and enemies respect the same walls — by DRIVING bodies into them,
// not by reasoning about the maths.
//
// Usage: bun tools/test-structures.mjs
//
// Every case is the same experiment. Aim the camera along a bearing (movement is
// camera-relative, so the camera is the steering wheel — see Player.aimCamera),
// drop the hero a few units back along it, hold W, read where he stopped.
//
// It runs TWICE: once normally, once with `solids=0`, which keeps every mesh and
// removes only the blocking (core/flags.ts). So each case reports the same walk
// into the same wall with the only difference being whether the wall is there —
// which is the honest before/after for "does this collision do anything".
//
// Aiming is DERIVED, never hard-coded: `__dbgStructures` reports the real boxes
// around whatever the town registry says is there, so the test follows the
// seed's layout instead of pinning a set of coordinates to it.
//
// The `solids=0` arm REUSES the geometry the first arm measured, and has to.
// `debugStructures` is gated on the same flag as the collision (world/index.ts)
// so the overlay can never draw a cage around something that is not stopping
// anyone — which is right for the overlay and leaves this run with nothing to
// aim at. Asking the world with the walls off returned an empty list and the
// second arm died on `boxes[0]`. Both arms now walk at the same coordinates,
// which is what makes them comparable anyway.
import { launchBrowser, newPage, wait, logPageErrors } from './browser.mjs';

const SETTLE = 5000;
/** How long a movement key is held per case. At 6 m/s that is ~15 units. */
const HOLD_MS = 2500;

const browser = await launchBrowser();

const round = (v, n = 2) => +v.toFixed(n);
const bearing = (fromX, fromZ, toX, toZ) => Math.atan2(toX - fromX, toZ - fromZ);

/** Aim, teleport, hold W, and report the ends of the walk. */
async function walk(page, startX, startZ, yaw, holdMs = HOLD_MS) {
  await page.evaluate(([x, z, y]) => {
    window.__dbgTp(x, z);
    window.__dbgAim(y);
  }, [startX, startZ, yaw]);
  // The camera's forward is derived from its SMOOTHED position, so a big swing
  // needs a few hundred ms to arrive. Pressing W before it does walks the hero
  // off along the old heading — which is exactly the bug this wait fixes, and
  // it showed up as every case travelling backwards.
  await wait(900);
  await page.evaluate(([x, z, y]) => {
    window.__dbgTp(x, z);
    window.__dbgAim(y);
  }, [startX, startZ, yaw]);
  await wait(400);
  const camErrDeg = await page.evaluate((want) => {
    let d = (window.__dbgCamYaw() + Math.PI - want) * 180 / Math.PI;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    return Math.abs(d);
  }, yaw);
  const before = await page.evaluate(() => window.__dbgPlayerPos());
  // Was the hero dropped INSIDE something? A teleport can do that where walking
  // cannot, and it would make a short walk look like a block when it is a stuck.
  const startAt = await page.evaluate(
    ([x, z]) => window.__dbgWorld(x, z), [before.x, before.z],
  );
  await page.keyboard.down('KeyW');
  await wait(holdMs);
  await page.keyboard.up('KeyW');
  await wait(200);
  const after = await page.evaluate(() => window.__dbgPlayerPos());
  const at = await page.evaluate(([x, z]) => window.__dbgWorld(x, z), [after.x, after.z]);
  return {
    /** How far off the intended bearing the camera actually pointed, degrees. */
    aimErrorDeg: round(camErrDeg, 1),
    startedInsideABox: startAt.structureTop > before.y + 0.5,
    start: { x: round(before.x), y: round(before.y), z: round(before.z) },
    end: { x: round(after.x), y: round(after.y), z: round(after.z) },
    travelled: round(Math.hypot(after.x - before.x, after.z - before.z)),
    /** Non-null means the hero ENDED UP standing in a column a structure covers. */
    structureTopHere: at.structureTop === null || at.structureTop === -Infinity
      ? null : round(at.structureTop),
    groundHere: round(at.ground),
  };
}

async function run(solids, geom = null) {
  const page = await newPage(browser, { width: 1000, height: 640 });
  logPageErrors(page);
  await page.goto(
    `http://localhost:5187/?fps=30&menu=0${solids ? '' : '&solids=0'}`,
    { waitUntil: 'load' },
  );
  await page.waitForSelector('canvas');
  await wait(SETTLE);

  const towns = await page.evaluate(() => window.__dbgTowns());
  /** Boxes per town id, measured on the solid arm and handed to the other. */
  const measured = {};
  let campBoxes = null;
  const out = { solids, structures: towns.structures, cases: {} };

  /** Drive from `from` toward `to`, holding W. */
  const drive = async (name, fromX, fromZ, toX, toZ, extra = {}) => {
    const r = await walk(page, fromX, fromZ, bearing(fromX, fromZ, toX, toZ));
    out.cases[name] = {
      aimedAt: { x: round(toX), z: round(toZ) },
      ...r,
      distToAim: round(Math.hypot(r.end.x - toX, r.end.z - toZ)),
      ...extra,
    };
    return out.cases[name];
  };

  for (const town of towns.towns) {
    const boxes = geom ? geom.towns[town.id] : await page.evaluate(
      ([x, z, r]) => window.__dbgStructures(x, z, r),
      [town.x, town.z, town.radius + 2],
    );
    measured[town.id] = boxes;
    if (!boxes.length) throw new Error(`no structure boxes reported for ${town.id}`);
    const gAng = town.gateBearingDeg * Math.PI / 180;
    const pt = (ang, d) => [town.x + Math.sin(ang) * d, town.z + Math.cos(ang) * d];

    // ---- the biggest box in town: a hut ----------------------------------
    // Approach from OUTSIDE it, along the line from the town centre, so the
    // walk meets a wall face on.
    const hut = boxes[0];
    {
      const a = bearing(town.x, town.z, hut.x, hut.z);
      const back = Math.max(hut.hx, hut.hz) + 7;
      const [sx, sz] = [hut.x + Math.sin(a) * back, hut.z + Math.cos(a) * back];
      await drive(`${town.id}/hut`, sx, sz, hut.x, hut.z, { box: hut });
    }

    // ---- a crate: waist-high, wider than a post, and jumpable-onto --------
    // The apex of a jump is 1.61 units (see MAX_STEP_UP), so a box under that is
    // one the hero can stand on top of — which is the other half of the step
    // rule and the only way to show that a box top really is a floor.
    const crate = boxes.filter((b) => {
      const h = b.top - b.ground;
      return h > 0.6 && h < 1.55 && b.area > 0.8 && b.area < 6;
    }).sort((p, q) => q.area - p.area)[0];
    if (crate) {
      const a = bearing(town.x, town.z, crate.x, crate.z);
      const [sx, sz] = [crate.x + Math.sin(a) * 4.5, crate.z + Math.cos(a) * 4.5];
      const c = await drive(`${town.id}/crate`, sx, sz, crate.x, crate.z, { box: crate });
      // Now jump onto it. Sampled rather than read once at the end: he is still
      // holding W, so a barrel is 2 units of standing and then a step off the
      // far side — "where was he when it was over" answers the wrong question.
      // What is being shown is that a box top HOLDS HIM UP, so the measurement
      // is the highest his feet ever were while the game considered him grounded.
      let peak = -Infinity;
      await page.keyboard.down('KeyW');
      for (let k = 0; k < 3; k++) {
        await page.keyboard.press('Space');
        for (let s = 0; s < 8; s++) {
          await wait(70);
          const g = await page.evaluate(() => ({
            y: window.__dbgPlayerPos().y, onGround: window.__dbgInput().onGround,
          }));
          if (g.onGround && g.y > peak) peak = g.y;
        }
      }
      await page.keyboard.up('KeyW');
      c.afterJump = {
        highestGroundedFeetY: peak === -Infinity ? null : round(peak),
        boxTop: crate.top,
        groundUnderBox: crate.ground,
        stoodOnBox: peak > crate.ground + 0.5,
      };
    }

    // ---- the perimeter, on the side away from the gate -------------------
    // Camps have a palisade; hamlets have a fence arc. Either way, walk in from
    // outside on the far bearing and see whether the hero reaches the middle.
    //
    // `endCentreDist` is REPORTED, not asserted on, and that is the fix for a
    // wrong result this test gave once: it used to call the walk a pass when the
    // hero ended further out than `radius - 1`, which quietly assumed the wall
    // stands ON the footprint circle. The Encampment's wall is now a SQUARE with
    // a half-side of 16.8 inside a footprint of 19, so a hero stopped dead
    // against the timber ends up ~17.6 from the middle and the old test called
    // that "got inside" — it had blocked him perfectly. Whether a wall stopped
    // him is a question about the same walk with the wall removed, which is the
    // control arm this tool already runs; compare the two.
    {
      const wallAng = gAng + Math.PI;
      const [sx, sz] = pt(wallAng, town.radius + 5);
      const w = await drive(`${town.id}/perimeter`, sx, sz, town.x, town.z);
      w.endCentreDist = round(Math.hypot(w.end.x - town.x, w.end.z - town.z));
      w.townRadius = town.radius;
    }

    // ---- the gate: this one MUST let him through --------------------------
    {
      const [sx, sz] = pt(gAng, town.radius + 7);
      const g = await drive(`${town.id}/gate`, sx, sz, town.x, town.z);
      g.endCentreDist = round(Math.hypot(g.end.x - town.x, g.end.z - town.z));
      g.townRadius = town.radius;
      // The gate's assertion is the comparison, not a radius: it must land him
      // as deep in as the walk with no collision at all.
    }
  }

  // ---- beasts and enemies -----------------------------------------------
  // The one way settlement collision can come out WORSE than none at all is a
  // beast standing inside the hut its owner is leaning on. So: park the hero
  // against a wall deep inside the camp, let his followers pile in behind him
  // and the wild spawns come to him, then read where every body actually is.
  {
    const camp = towns.towns.find((c) => c.kind === 'camp');
    const boxes = geom ? geom.camp : await page.evaluate(
      ([x, z, r]) => window.__dbgStructures(x, z, r), [camp.x, camp.z, camp.radius],
    );
    campBoxes = boxes;
    const hut = boxes[0];
    // From the CAMP SIDE, so the approach stays inside the palisade — coming at
    // the hut from outside only tests the wall again.
    const a = Math.atan2(camp.x - hut.x, camp.z - hut.z);
    const sx = hut.x + Math.sin(a) * (Math.max(hut.hx, hut.hz) + 7);
    const sz = hut.z + Math.cos(a) * (Math.max(hut.hx, hut.hz) + 7);
    await walk(page, sx, sz, bearing(sx, sz, hut.x, hut.z), 6000);
    await wait(1500);
    const b = await page.evaluate(() => window.__dbgBodies());
    // `overFeet` is the structure top minus the body's own feet. Above the step
    // height it is standing in a wall; null is open ground.
    const inWall = (o) => o.overFeet !== null && o.overFeet > 0.5;
    out.bodies = {
      hut,
      hero: { ...b.player, insideAWall: inWall(b.player) },
      beasts: b.beasts.map((p) => ({
        ...p,
        insideAWall: inWall(p),
        distToHut: round(Math.hypot(p.x - hut.x, p.z - hut.z)),
      })),
      enemyCount: b.enemies.length,
      enemiesInsideAWall: b.enemies.filter(inWall).length,
      // The nearest one to the hut, which is the interesting one: an enemy that
      // chased the hero up to a wall and stopped at it.
      nearestEnemyToHut: b.enemies
        .map((e) => ({ ...e, d: round(Math.hypot(e.x - hut.x, e.z - hut.z)) }))
        .sort((p, q) => p.d - q.d)[0] ?? null,
    };
  }

  // ---- what the query costs ---------------------------------------------
  // The whole point of the grid in world/structures.ts. Measured in the middle
  // of the camp (a bucket with boxes in it) and out in open country (a bounds
  // test and a failed lookup), because those are the two cases the frame loop
  // actually hits.
  {
    const camp = towns.towns.find((c) => c.kind === 'camp');
    out.cost = {
      inCamp: await page.evaluate(([x, z]) => window.__dbgBenchStructures(x, z),
        [camp.x, camp.z]),
      wilderness: await page.evaluate(([x, z]) => window.__dbgBenchStructures(x, z),
        [camp.x + 900, camp.z + 900]),
    };
  }

  await page.close();
  out.geometry = { towns: measured, camp: campBoxes };
  return out;
}

const withCollision = await run(true);
const withoutCollision = await run(false, withCollision.geometry);
delete withCollision.geometry;
delete withoutCollision.geometry;
await browser.close();

console.log(JSON.stringify({ withCollision, withoutCollision }, null, 2));
