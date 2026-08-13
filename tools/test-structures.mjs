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
import { launchBrowser, newPage, wait, logPageErrors } from "./browser.mjs";
import { BASE as HOST } from "./target.mjs";

/** `overFeet` is the structure top minus the body's own feet; above the step
 *  height the body is standing in a wall, and null is open ground. */
const inWall = (o) => o.overFeet !== null && o.overFeet > 0.5;

const SETTLE = 5000;
/** How long a movement key is held per case. At 6 m/s that is ~15 units. */
const HOLD_MS = 2500;
/** How far back along its own facing a den walk starts, world units. */
const DEN_BACK = 8;
/**
 * How near the middle of a den the hero has to end up for the shop to still be
 * openable — `nearShop` in main.ts is `distanceTo(...) < 3.5`.
 *
 * This is the assertion that makes the den case two-sided rather than one. A
 * collider that stops the player five units out passes every "is it solid" test
 * there is and ships a shop nobody can buy from.
 */
const DEN_SHOP_RANGE = 3.5;

const browser = await launchBrowser();

const round = (v, n = 2) => +v.toFixed(n);
const bearing = (fromX, fromZ, toX, toZ) => Math.atan2(toX - fromX, toZ - fromZ);

/**
 * How close the camera has to be to the wanted bearing before the walk starts,
 * in degrees.
 *
 * 2, against a settle that used to be 1300 ms of flat sleep. Measured over the
 * 40 cases this file drives, that sleep left a median error of 0.0 degrees and
 * a worst of 1.5 — i.e. it was waiting long after the camera had arrived, on
 * every walk, twice per run. 2 is above that worst case and a fortieth of the
 * ~80 degrees a mis-aimed walk is wrong by, so it separates "arrived" from
 * "still swinging" with room on both sides.
 */
const AIM_TOLERANCE_DEG = 2;
/** How long to keep waiting for it before giving up and walking anyway. */
const AIM_TIMEOUT = 1500;
/** Gap between polls. Two frames at the 30 fps this probe pins itself to. */
const AIM_POLL = 66;

/** Aim, teleport, hold W, and report the ends of the walk. */
async function walk(page, startX, startZ, yaw, holdMs = HOLD_MS) {
  // WAIT FOR THE CONDITION, NOT FOR THE CLOCK. The camera's forward is derived
  // from its SMOOTHED position, so a big swing needs a few hundred ms to
  // arrive; pressing W before it does walks the hero off along the old heading,
  // which showed up as every case travelling backwards. That was fixed with two
  // fixed sleeps totalling 1300 ms — correct, and the single most expensive
  // line in the suite: 42 walks a run at 4.2 s each is 177 s, 83% of this
  // probe, and this probe is a fifth of `probe.mjs all`.
  //
  // The error is polled instead, using the very number the walk already
  // reports. The re-teleport stays inside the loop because it was always doing
  // two jobs: re-aiming, and putting the hero back where gravity has been
  // pulling him out of since the last one.
  const place = () =>
    page.evaluate(
      ([x, z, y]) => {
        window.__dbgTp(x, z);
        window.__dbgAim(y);
      },
      [startX, startZ, yaw],
    );
  const aimError = () =>
    page.evaluate((want) => {
      let d = ((window.__dbgCamYaw() + Math.PI - want) * 180) / Math.PI;
      while (d > 180) {
        d -= 360;
      }
      while (d < -180) {
        d += 360;
      }
      return Math.abs(d);
    }, yaw);

  await place();
  const deadline = Date.now() + AIM_TIMEOUT;
  let camErrDeg = await aimError();
  while (camErrDeg > AIM_TOLERANCE_DEG && Date.now() < deadline) {
    await wait(AIM_POLL);
    await place();
    camErrDeg = await aimError();
  }
  const before = await page.evaluate(() => window.__dbgPlayerPos());
  // Was the hero dropped INSIDE something? A teleport can do that where walking
  // cannot, and it would make a short walk look like a block when it is a stuck.
  const startAt = await page.evaluate(([x, z]) => window.__dbgWorld(x, z), [before.x, before.z]);
  await page.keyboard.down("KeyW");
  await wait(holdMs);
  await page.keyboard.up("KeyW");
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
    structureTopHere:
      at.structureTop === null || at.structureTop === -Infinity ? null : round(at.structureTop),
    groundHere: round(at.ground),
  };
}

async function run(solids, geom = null) {
  const page = await newPage(browser, { width: 1000, height: 640 });
  logPageErrors(page);
  await page.goto(`${HOST}/?fps=30&menu=0${solids ? "" : "&solids=0"}`, { waitUntil: "load" });
  await page.waitForSelector("canvas");
  await wait(SETTLE);

  const towns = await page.evaluate(() => window.__dbgTowns());
  // A CARRIED SETTLEMENT IS NOT THIS FILE'S. Every walk below teleports the
  // hero to a world coordinate and drives him at a collider reported by
  // `__dbgStructures`, and neither of those means anything for a town on a
  // moving frame: its boxes live in the carrier's own coordinates (see
  // world/sky-island.ts) and its position is a different number by the time the
  // hero gets there. `tools/test-carrier.mjs` is the guard for that one, and it
  // asserts the same things this file does — that the deck holds a body up, and
  // that what is built on it stops one.
  const sited = towns.towns.filter((tn) => !tn.carried);
  // ONE SETTLEMENT IS WALKED, NOT ALL OF THEM. See AGENTS.md: buildings that
  // share a builder share its bugs, so driving the hero into three towns' huts
  // tests `world/structures.ts` three times rather than testing three things.
  // Measured, that repetition was 16 of the 20 cases per arm and ~120 s of a
  // 186 s run — a fifth of the whole probe suite spent re-proving one rule.
  //
  // The CAMP is the representative because it is the richest: a palisade, a
  // gate, huts, ridge tents and crates, i.e. every collider primitive the town
  // builders emit. The other settlements are still covered by the collider
  // BUDGET below, which counts their boxes and roofs without walking anywhere —
  // that is the check that catches a builder regressing, and it is free.
  const walked = sited.filter((tn) => tn.kind === "camp").slice(0, 1);
  if (!walked.length) {
    walked.push(sited[0]);
  }
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

  for (const town of walked) {
    const boxes = geom
      ? geom.towns[town.id]
      : await page.evaluate(
          ([x, z, r]) => window.__dbgStructures(x, z, r),
          [town.x, town.z, town.radius + 2],
        );
    measured[town.id] = boxes;
    if (!boxes.length) {
      throw new Error(`no structure boxes reported for ${town.id}`);
    }
    const gAng = (town.gateBearingDeg * Math.PI) / 180;
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
    const crate = boxes
      .filter((b) => {
        const h = b.top - b.ground;
        return h > 0.6 && h < 1.55 && b.area > 0.8 && b.area < 6;
      })
      .toSorted((p, q) => q.area - p.area)[0];
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
      await page.keyboard.down("KeyW");
      for (let k = 0; k < 3; k++) {
        await page.keyboard.press("Space");
        for (let s = 0; s < 8; s++) {
          await wait(70);
          const g = await page.evaluate(() => ({
            y: window.__dbgPlayerPos().y,
            onGround: window.__dbgInput().onGround,
          }));
          if (g.onGround && g.y > peak) {
            peak = g.y;
          }
        }
      }
      await page.keyboard.up("KeyW");
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

  // ---- the skill dens ----------------------------------------------------
  // The one class of building that is not in the town registry, and the one that
  // was still scenery: the hero walked in one side of the pagoda and out the
  // other, through the back wall, the counter and the shelf of bottles.
  //
  // TWO approaches per den, because they ask different questions and only one of
  // them is about collision at all.
  //
  //   BACK is the wall. The far side of a den is a solid cream wall with beams,
  //   and nothing may pass it — this is the case that fails on the build this
  //   fixes, and its control arm walks the identical line with the blocking
  //   removed.
  //
  //   FRONT is the shopfront, and it asserts the OPPOSITE thing: that the fix
  //   did not go too far. A shop opens with E within 3.5 units of its middle
  //   (`nearShop`, main.ts), so a collider that stopped the player further out
  //   than that would be a shop nobody can buy from, which is worse than one you
  //   walk through. It deliberately makes NO claim about reaching the middle: a
  //   pagoda is open along its sides between the counter and the corner posts,
  //   and a hero who walks in through that gap has gone through a doorway rather
  //   than a wall. Measured, that is exactly what one of the four does.
  //
  // `passedCentreBy` is the discriminator on the back walk and `travelled` is
  // not: BOTH arms end up far from the middle of the den — one stopped short of
  // it, the other clean through and out the far side — so the signed progress
  // along the approach is what tells those two apart.
  {
    const dens = await page.evaluate(() => window.__dbgShops());
    out.dens = [];
    // TWO DENS, NOT ALL FOUR, by the same rule as the settlement above: every
    // den is the same builder, so the fourth walk re-proves the first.
    //
    // Two rather than one because of a fact this file already records: the
    // ground behind one of them terraces a full unit against a MAX_STEP_UP of
    // 0.5, so the terrain stops the hero in BOTH arms and that den can prove
    // nothing. One den would be a run that fails whenever the seed hands it
    // that one; a spare is what keeps the trim honest rather than lucky.
    const DENS_WALKED = 2;
    for (let i = 0; i < Math.min(dens.length, DENS_WALKED); i++) {
      const d = dens[i];
      /** Walk in along `ang`, from DEN_BACK units out, and read where he got to. */
      const approach = async (name, ang) => {
        const sx = d.x + Math.sin(ang) * DEN_BACK;
        const sz = d.z + Math.cos(ang) * DEN_BACK;
        const r = await drive(`den${i}/${name}`, sx, sz, d.x, d.z, { den: d });
        // Where he ended up along the approach line, measured from the middle of
        // the den outward toward where he started: DEN_BACK at the start, 0 at
        // the middle, negative out the far side.
        const ahead = (r.end.x - d.x) * Math.sin(ang) + (r.end.z - d.z) * Math.cos(ang);
        return {
          endCentreDist: round(Math.hypot(r.end.x - d.x, r.end.z - d.z)),
          /** Positive means he ended up out the FAR side of the den. */
          passedCentreBy: round(-ahead),
          travelled: r.travelled,
          aimErrorDeg: r.aimErrorDeg,
          startedInsideABox: r.startedInsideABox,
        };
      };
      out.dens.push({
        i,
        den: d,
        back: await approach("back", d.facing + Math.PI),
        front: await approach("front", d.facing),
      });
    }
  }

  // ---- beasts and enemies -----------------------------------------------
  // The one way settlement collision can come out WORSE than none at all is a
  // beast standing inside the hut its owner is leaning on. So: park the hero
  // against a wall deep inside the camp, let his followers pile in behind him
  // and the wild spawns come to him, then read where every body actually is.
  {
    const camp = sited.find((c) => c.kind === "camp");
    const boxes = geom
      ? geom.camp
      : await page.evaluate(
          ([x, z, r]) => window.__dbgStructures(x, z, r),
          [camp.x, camp.z, camp.radius],
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
      nearestEnemyToHut:
        b.enemies
          .map((e) => ({ ...e, d: round(Math.hypot(e.x - hut.x, e.z - hut.z)) }))
          .toSorted((p, q) => p.d - q.d)[0] ?? null,
    };
  }

  // ---- what the query costs ---------------------------------------------
  // The whole point of the grid in world/structures.ts. Measured in the middle
  // of the camp (a bucket with boxes in it) and out in open country (a bounds
  // test and a failed lookup), because those are the two cases the frame loop
  // actually hits.
  {
    const camp = sited.find((c) => c.kind === "camp");
    out.cost = {
      inCamp: await page.evaluate(([x, z]) => window.__dbgBenchStructures(x, z), [camp.x, camp.z]),
      wilderness: await page.evaluate(
        ([x, z]) => window.__dbgBenchStructures(x, z),
        [camp.x + 900, camp.z + 900],
      ),
    };
  }

  // ---- how many colliders, and how well the roofs fit --------------------
  // The budget's raw material. Counted per town rather than per template
  // because that is what a probe standing in the world can see, and it is the
  // number that moves when someone answers a shape problem with more boxes.
  {
    out.colliders = { perTown: [], roofs: 0, worstRoofFit: 0 };
    for (const town of sited) {
      const r = town.radius + 4;
      // STAND IN THE TOWN BEFORE COUNTING IT. A structure's colliders arrive
      // with its chunk, so what this reports is what is STREAMED, not what the
      // registry knows about. That distinction cost nothing while the three
      // towns stood ~250 units apart and were resident together; at a kilometre
      // a leg (issue #184) counting Redbriar from the Encampment reports zero,
      // which reads as "the builder produced nothing" and is really "you are
      // not there". Wait on the world rather than on a clock, per AGENTS.md.
      await page.evaluate(([x, z]) => window.__dbgTp(x, z), [town.x, town.z]);
      await page
        .waitForFunction(() => !window.__dbgZone().streaming, { timeout: 60000 })
        .catch(() => {});
      const [boxes, roofs] = await page.evaluate(
        ([x, z, rad]) => [window.__dbgStructures(x, z, rad).length, window.__dbgRidges(x, z, rad)],
        [town.x, town.z, r],
      );
      out.colliders.perTown.push({
        id: town.id,
        boxes,
        roofs: roofs.length,
        total: boxes + roofs.length,
        worstRoofFit: roofs.reduce((m, o) => Math.max(m, o.fit), 0),
      });
    }
    const all = await page.evaluate(() => window.__dbgRidges(0, 0, 1e6));
    out.colliders.roofs = all.length;
    out.colliders.worstRoofFit = round(
      all.reduce((m, o) => Math.max(m, o.fit), 0),
      3,
    );
  }

  await page.close();
  out.geometry = { towns: measured, camp: campBoxes };
  return out;
}

/**
 * THE COLLIDER BUDGET — what stops the next agent answering a shape problem
 * with a thousand more boxes.
 *
 * Every other assertion in this file is about whether the collision WORKS. These
 * two are about whether it is any good, and they exist because the collision can
 * be perfect by every test above and still be the thing issue #3 was reported
 * for. Two ways to get that wrong, one number each:
 *
 *   TOO MANY. Decomposing each roof into boxes that follow its steps took the
 *   world from 193 colliders to 2326 and tripled `structureTopAt` inside a camp.
 *   Nothing here failed. `total` per town fails on any INCREASE, exactly as
 *   test-zfight's seam budget does, so a change that adds forty colliders to a
 *   hut has to be looked at rather than merged.
 *
 *   BADLY SHAPED. `worstRoofFit` is how far a roof cylinder stands off the
 *   thatch it was fitted to at its worst point (`SolidRidge.fitError`,
 *   world/structures.ts). It is the whole of "does the collider follow the
 *   model" as a number, and it is the one the issue's screenshots were of.
 *
 * A town missing from the table is a town this tool has never seen. Budget 0, so
 * it has to be looked at — the same rule zfight applies to a new species.
 *
 * ADD A BUILDING AND YOU RE-BASELINE THESE IN THE SAME COMMIT, having looked at
 * what it did. That is the point of the failure, not a chore around it.
 *
 * The query COST is deliberately not budgeted, though it is reported above. It
 * is host-dependent — the same rule the frame-rate assertions in this repo obey
 * — so any threshold loose enough to be honest on a software rasteriser would
 * have passed the 2326-box version at 92 ns anyway. The count is the guard; the
 * cost is the explanation.
 */
//
// RE-BASELINED WHEN THE TOWNS MOVED A KILOMETRE APART (issue #184). Not one
// builder changed; the sites did, and a layout places what its ground allows.
// What that did, measured on seed 1337 and looked at rather than accepted:
//
//   encampment  64 -> 64   UNCHANGED, and that is the assertion rather than a
//                          non-event: the distance is spent between the fork and
//                          the hamlets, so the camp's own ground, its gate
//                          bearing and everything arranged around them are
//                          exactly as they were. A change here would mean the
//                          starting country had moved.
//   redbriar    41 -> 36   a paddock's collider count IS its bay count
//   stonewatch  28 -> 39   (world/fences.ts), and `buildFence` refuses a bay it
//                          cannot lift clear of the ground under it — so a
//                          hamlet's count is a reading of how even its new
//                          ground is, and the two moved in opposite directions
//                          because they landed on different country.
//
const BUDGET = {
  //           colliders   of which roofs
  encampment: { total: 64, roofs: 5 }, // 3 huts, 2 ridge tents, 59 boxes
  // The hamlet counts were 38 -> 40 and 25 -> 27 boxes when the paddock arc
  // became a fence CHAIN (world/fences.ts, issue #105) instead of seven fixed
  // panels: a chain's collider is one box per bay — the top plank, which spans
  // its bay end to end. The posts and the lower plank carry no collider at all,
  // so the count is the number of BAYS and nothing else, which is why re-siting
  // a town moves it.
  // 36 -> 37 WHEN MERA MOVED IN (issue #149). A character is solid by the same
  // primitive a crate is — the footprint is measured off the voxel model the
  // builder painted (`measureFootprint`) and stamped into the settlement's own
  // field — so a resident is one collider, and a hamlet that gains a person
  // gains one. Gain has always been the Encampment's 64th.
  redbriar: { total: 37, roofs: 1 }, // 1 hut, 1 miller
  stonewatch: { total: 39, roofs: 1 }, // 1 hut
};
/**
 * How far a roof cylinder may stand off its own thatch, world units.
 *
 * 0.6 is the debt the two roofs in the game already carry (0.394 on a hut,
 * 0.577 on a ridge tent) and not a target. The target is MAX_STEP_UP, 0.5:
 * under it the mismatch is smaller than a step the hero takes without noticing,
 * over it he visibly floats over a roof or sinks into one. Getting there means a
 * WEDGE primitive rather than a finer fit — a straight-sided gable is a shape no
 * circle can be — so bring it down and lower this number in the same commit.
 */
const ROOF_FIT_LIMIT = 0.6;

/**
 * Does a GROUND MOUNT stand on what the hero stands on?
 *
 * Every other case in this file drives the hero on foot, which is why none of
 * them could see issue #32: `MountController` kept its own copy of "how high is
 * the world here", and that copy asked the terrain alone. The horizontal step
 * test used `blockTop` (terrain + trunks + anything a settlement built), so a
 * crate STOPPED a mount at its wall — and then, once the mount was on top of
 * one, the vertical clamp dropped it straight through to the dirt. Refused at
 * the side, unsupported on top.
 *
 * The measurement is a PAIR at one column, which is the only way to tell "the
 * mount fell through" from "there was nothing there to stand on": the hero on
 * foot must come to rest exactly ON the built top, and the rider must then come
 * to rest ABOVE it rather than a metre inside it.
 *
 * Mounting is staged through the dev console rather than by holding F next to a
 * beast — `/mount <id>` is the same code path and it does not depend on where
 * the follower happened to wander.
 */
async function rideOnFurniture() {
  const page = await newPage(browser, { width: 1280, height: 800 });
  logPageErrors(page);
  await page.goto(`${HOST}/?menu=0&fs=0`, { waitUntil: "load" });
  await page.waitForSelector("canvas");
  await wait(SETTLE);

  // Somewhere in camp with real furniture under it. The band is deliberate:
  // below 0.6 there is nothing to fall through, and above ~2.4 it is a roof
  // rather than something a player would ever be standing on.
  const spot = await page.evaluate(() => {
    const t = window.__dbgTowns().towns.find((n) => n.id === "encampment");
    const hits = [];
    for (let dx = -26; dx <= 26; dx += 0.5) {
      for (let dz = -26; dz <= 26; dz += 0.5) {
        const x = t.x + dx;
        const z = t.z + dz;
        const w = window.__dbgWorld(x, z);
        if (!Number.isFinite(w.structureTop)) {
          continue;
        }
        const rise = w.structureTop - w.ground;
        if (rise > 0.6 && rise < 2.4) {
          hits.push({ x, z, ground: w.ground, top: w.structureTop, rise });
        }
      }
    }
    // The middle of the list rather than the first, which is always a rim.
    return hits.length ? hits[Math.floor(hits.length / 2)] : null;
  });
  if (!spot) {
    await page.close();
    return { found: false };
  }

  await page.evaluate((s) => window.__dbgTp(s.x, s.z), spot);
  await wait(900);
  const onFootY = (await page.evaluate(() => window.__dbgPlayerPos())).y;

  await page.keyboard.press("Backquote");
  await page.waitForSelector(".bs-console-input", { visible: true });
  await page.type(".bs-console-input", "/mount emberfox");
  await page.keyboard.press("Enter");
  await wait(300);
  await page.keyboard.press("Backquote");
  await wait(1200);
  const m = await page.evaluate(() => window.__dbgMount());
  await page.close();

  return {
    found: true,
    at: { x: round(spot.x), z: round(spot.z) },
    ground: round(spot.ground),
    structureTop: round(spot.top),
    rise: round(spot.rise),
    onFootY: round(onFootY),
    locomotion: m.locomotion,
    // `__dbgMount().y` is the RIDER, so this sits a saddle's height over the
    // surface the animal is on. That is what makes it a clean discriminator:
    // on top of the crate it is above `structureTop`, through it, it is below.
    riderY: round(m.y),
    /** How far the rider ended up UNDER the thing he should be sitting on. */
    riderSink: round(spot.top - m.y),
  };
}

const withCollision = await run(true);
const withoutCollision = await run(false, withCollision.geometry);
delete withCollision.geometry;
delete withoutCollision.geometry;
const mounted = await rideOnFurniture();
await browser.close();

const overBudget = [];
const unbudgeted = [];
for (const t of withCollision.colliders.perTown) {
  const b = BUDGET[t.id];
  if (!b) {
    unbudgeted.push(t.id);
    continue;
  }
  if (t.total > b.total) {
    overBudget.push({ id: t.id, what: "colliders", is: t.total, budget: b.total });
  }
  if (t.roofs > b.roofs) {
    overBudget.push({ id: t.id, what: "roofs", is: t.roofs, budget: b.roofs });
  }
}
if (withCollision.colliders.worstRoofFit > ROOF_FIT_LIMIT) {
  overBudget.push({
    id: "world",
    what: "roofFit",
    is: withCollision.colliders.worstRoofFit,
    budget: ROOF_FIT_LIMIT,
  });
}

// The dens. THE CONTROL ARM IS THE GATE, not a second opinion: "he stopped
// before the middle" is equally true of a hero who never set off, so a claim
// about a den is only made where the same walk with `solids=0` actually reached
// it. Measured, one of the four cannot be measured from behind — the ground
// there terraces a full unit against a MAX_STEP_UP of 0.5, so the terrace stops
// him in BOTH arms and the walk says nothing about the shop.
//
// Reported as inconclusive rather than failed, and the run fails if NOTHING
// could be measured. That is the difference between a test that is honest about
// its reach and one that pins a seed's landscape.
const denFail = [];
const denInconclusive = [];
let denMeasured = 0;
if (!withCollision.dens?.length) {
  denFail.push("no skill dens reported by __dbgShops");
} else {
  for (const d of withCollision.dens) {
    const control = withoutCollision.dens.find((o) => o.i === d.i);
    if (d.back.startedInsideABox || d.front.startedInsideABox) {
      denFail.push(`den${d.i}: a walk started inside a collider, so it measures nothing`);
      continue;
    }
    // BACK — the wall. Only asked where the control walked through it.
    if (!control || control.back.passedCentreBy <= 0) {
      denInconclusive.push(
        `den${d.i}/back: the solids=0 control stopped ${control?.back.endCentreDist} units out ` +
          `too, so terrain and not the shop is what ends this walk`,
      );
    } else {
      denMeasured++;
      if (d.back.passedCentreBy > 0) {
        denFail.push(
          `den${d.i}: walked THROUGH the back wall — ended ${d.back.passedCentreBy} units out ` +
            `the far side, against ${control.back.passedCentreBy} with the blocking removed`,
        );
      }
    }
    // FRONT — the shopfront, and the opposite claim. Same gate: a hero the
    // landscape never let near the counter says nothing about whether a collider
    // walled it off.
    //
    // The gate is `passedCentreBy`, NOT the control's own `endCentreDist`: with
    // the blocking removed the hero walks clean through the pagoda and finishes
    // six units out the far side, so the control ends FURTHER from the middle
    // than the blocked walk does. What it has to show is that it got there —
    // that the landscape let him within shop range of the counter at all.
    if (!control || control.front.passedCentreBy < -DEN_SHOP_RANGE) {
      denInconclusive.push(
        `den${d.i}/front: the control walk never got within ${DEN_SHOP_RANGE} of the middle ` +
          `either, so the shop's reach cannot be judged from it`,
      );
    } else if (d.front.endCentreDist > DEN_SHOP_RANGE) {
      denFail.push(
        `den${d.i}: walking up to the front stops ${d.front.endCentreDist} units out, past the ` +
          `${DEN_SHOP_RANGE} the shop opens within — solid, but unshoppable`,
      );
    }
  }
  if (denMeasured === 0) {
    denFail.push("no den could be walked into from behind in the control arm — nothing was tested");
  }
}

// Issue #32. Both halves are asserted: the hero standing ON the furniture is
// what makes the mounted number mean anything, and without it a world where
// nothing is solid at all would pass.
const mountFail = [];
if (!mounted.found) {
  mountFail.push("no standable furniture found in the Encampment to test against");
} else {
  if (Math.abs(mounted.onFootY - mounted.structureTop) > 0.05) {
    mountFail.push(
      `on foot the hero does not rest on the furniture (y ${mounted.onFootY}, top ${mounted.structureTop})`,
    );
  }
  if (mounted.riderY < mounted.structureTop) {
    mountFail.push(
      `a ground mount sinks through it: rider ${mounted.riderY} is ${mounted.riderSink} below the ` +
        `${mounted.structureTop} it should be sitting on`,
    );
  }
}

console.log(
  JSON.stringify(
    {
      dens: {
        shopRange: DEN_SHOP_RANGE,
        solid: withCollision.dens,
        control: withoutCollision.dens,
        measuredFromBehind: denMeasured,
        inconclusive: denInconclusive,
        failures: denFail,
        pass: denFail.length === 0,
      },
      mounted: { ...mounted, failures: mountFail, pass: mountFail.length === 0 },
      budget: {
        roofFitLimit: ROOF_FIT_LIMIT,
        perTown: withCollision.colliders.perTown,
        worstRoofFit: withCollision.colliders.worstRoofFit,
        overBudget,
        unbudgeted,
        pass: overBudget.length === 0 && unbudgeted.length === 0,
      },
      withCollision,
      withoutCollision,
    },
    null,
    2,
  ),
);
if (overBudget.length || unbudgeted.length || mountFail.length || denFail.length) {
  process.exitCode = 1;
}
