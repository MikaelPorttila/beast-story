// Verifies both halves of the dynamic camera (issue #135): the spring arm
// shortens when something solid stands between the camera and the hero and
// lets go again when it does not, and whatever is left in the way is cut out
// of the picture.
//
// WHY THE TWO HALVES ARE MEASURED SEPARATELY. They are both "the hero became
// visible", so a run that turns the whole feature off and photographs the
// difference proves that SOMETHING happened and cannot say which mechanism did
// it. So:
//
//   the arm  is read as a NUMBER (`__dbgOcclusion().arm` against `armWanted`),
//            never from a picture, and A/B'd against `?occlude=0` — the same
//            walk, into the same wall, with the only difference being whether
//            the camera is allowed to give way.
//   the cut  is read as PIXELS, with the arm held still. `__dbgOcclude(0)`
//            takes the cut away and leaves the arm exactly where it is, so the
//            frame either side of it differs by the cut alone. The probe
//            asserts the arm did not move across that pair, which is what makes
//            the pixel difference attributable.
//
// AND THEY ARE MEASURED AGAINST DIFFERENT THINGS, which is the other half of
// keeping them apart. A WALL for the arm, because that is what the arm consults;
// a CANOPY for the cut, because the arm deliberately ignores crowns, so under an
// oak the cut is the only mechanism that can put the hero back on screen. Each
// mechanism is photographed where the other one cannot help it.
//
// HOW IT FINDS EITHER without knowing the seed's coordinates: `__dbgStructures`
// reports the settlement colliders near a point, `__dbgSurfaceY` fired from
// overhead finds the columns with foliage over them, and `__dbgCamYaw` reports
// the bearing the arm is currently swung to. Teleporting the hero to
// `target - bearing * offset` puts the target behind him, which is where the
// camera is. Nothing here is hand-placed, so a reseeded world still tests it.
//
// Usage: bun tools/test-occlusion.mjs        (dev server must be up)
import { launchBrowser, newPage, whenPlaying, frame, logPageErrors } from './browser.mjs';
import { BASE as HOST } from './target.mjs';

const BASE = `${HOST}/?menu=0&fs=0&vol=0&hud=0`;
/**
 * The still-life load for section 2's pixel work.
 *
 * A frame of this game is not the same twice: the grass waves, the clouds
 * drift, and the antialias pass jitters its sample. Photographed as it ships,
 * two BACK-TO-BACK frames differ by 2.5% of the window — more than the cut
 * being measured is worth. These three switches are the ones that move on their
 * own with nothing driving them, and none of them is the subject here.
 */
const STILL = `${BASE}&sway=0&clouds=0&aa=0`;
const W = 960;
const H = 600;

/**
 * How far up-bearing of the collider's centre to stand.
 *
 * Shorter than the default arm (7.4) on purpose: the collider then falls INSIDE
 * the swept arm rather than at its tip, so the free length comes back around
 * 5.5 and the assertion has room either side of it. The hero is still 6.5 units
 * clear of the thing — he is standing in the open with a wall at his back,
 * which is the case in the issue, not standing in a wall.
 */
const STAND_OFF = 6.5;

/**
 * How far a column's drawn surface has to stand above its ground before it
 * counts as a crown. 6 clears every rock, tussock and bush in the prop kit and
 * every roof in the settlement kit, and the oaks near spawn measure 8-12.
 */
const CANOPY_RISE = 6;
/**
 * How far back down the bearing to stand from the crown's column.
 *
 * Sized off the arm, not off the tree: at 6 the camera has climbed
 * `sin(0.46) * 6` — about 2.6 units above the chest pivot, so ~4 above the
 * hero's feet — which is where a crown's underside is. Nearer and it ducks
 * beneath the leaves; further and it comes out the other side of them.
 */
const CANOPY_OFF = 6;

const probe = (page, name, ...args) => page.evaluate(
  (n, a) => window[n]?.(...a), name, args);

const results = {};
let failures = 0;
const check = (name, ok, detail) => {
  results[name] = { ok, ...detail };
  if (!ok) failures++;
};

/**
 * Pick a wall to back into, and the spot to back into it from.
 *
 * TALLEST FIRST, not biggest: the camera rides `sin(pitch)` up the arm, so at
 * 6.5 units out it is already ~4 above the hero's feet and a crate is simply
 * not in its way — correctly. What blocks a third-person camera is a WALL.
 *
 * The candidate is then rejected unless its stand-off spot is CLEAR GROUND.
 * `__dbgTp` resolves onto the climbable top, and a camp is dense enough that
 * the spot behind one palisade span is very often the top of the next one —
 * where the hero stands 5 units up, the whole arm clears the fence, and there
 * is correctly nothing to pull in for. That is the second thing this probe got
 * wrong before it measured anything.
 */
async function findWall(page, r = 70) {
  const pos = await probe(page, '__dbgPlayerPos');
  const yaw = await probe(page, '__dbgCamYaw');
  const boxes = await probe(page, '__dbgStructures', pos.x, pos.z, r) ?? [];
  const tall = boxes
    .filter((b) => b.top - b.ground >= 4)
    .sort((a, b) => (b.top - b.ground) - (a.top - a.ground));
  for (const box of tall) {
    const x = box.x - Math.sin(yaw) * STAND_OFF;
    const z = box.z - Math.cos(yaw) * STAND_OFF;
    const crowd = await probe(page, '__dbgStructures', x, z, 3);
    if (crowd.length) continue;
    return { box, spot: { x: +x.toFixed(2), z: +z.toFixed(2) } };
  }
  return null;
}

/**
 * Find a tree crown to stand under, and the spot that puts it on the arm.
 *
 * There is no "where are the trees" hook and this does not add one:
 * `__dbgSurfaceY(x, z, 26)` fires a ray down from 26 units up and reports the
 * first mesh it meets, so a column whose surface sits `CANOPY_RISE` above the
 * ground it computed has foliage over it. Scanned in ONE page call over a
 * coarse grid — a crown is 7-10 units across, so a 3-unit step cannot miss one.
 *
 * Settlement columns are excluded so this cannot accidentally pick a roof, and
 * the spot is `CANOPY_OFF` back down the camera bearing, which parks the camera
 * in the leaves while the hero stands clear of the bole.
 */
async function findCanopies(page) {
  const pos = await probe(page, '__dbgPlayerPos');
  const yaw = await probe(page, '__dbgCamYaw');
  const hits = await page.evaluate((cx, cz, rise) => {
    const out = [];
    for (let x = cx - 60; x <= cx + 60; x += 3) {
      for (let z = cz - 60; z <= cz + 60; z += 3) {
        const s = window.__dbgSurfaceY(x, z, 26);
        if (s.sink === null || s.sink < rise) continue;
        if (!/props/.test(s.hit || '')) continue;
        if (window.__dbgStructures(x, z, 5).length) continue;
        out.push({ x: +x.toFixed(1), z: +z.toFixed(1), sink: s.sink });
      }
    }
    return out;
  }, pos.x, pos.z, CANOPY_RISE);
  return hits.map((h) => ({
    ...h,
    spot: {
      x: +(h.x - Math.sin(yaw) * CANOPY_OFF).toFixed(2),
      z: +(h.z - Math.cos(yaw) * CANOPY_OFF).toFixed(2),
    },
  }));
}

/** Stand on the spot and let the world settle in SIMULATED time, not a clock. */
async function standAt(page, spot) {
  await page.evaluate((x, z) => window.__dbgTp(x, z), spot.x, spot.z);
  await probe(page, '__dbgAdvance', 3);
}

/** The whole window, reduced to a byte array a diff can walk. */
async function pixels(page) {
  await frame(page);
  const b64 = await page.screenshot({ encoding: 'base64' });
  return page.evaluate(async (data) => {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res; img.onerror = rej; img.src = `data:image/png;base64,${data}`;
    });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, img.width, img.height).data;
    // Handed back as a plain array of luma bytes: one number per pixel is a
    // quarter of the traffic over CDP, and a cut-away is a luma change.
    const out = new Array(img.width * img.height);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      out[p] = Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
    }
    return out;
  }, b64);
}

/** Fraction of pixels whose luma moved by more than a compression-safe margin. */
function diff(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 6) n++;
  return +(n / a.length).toFixed(4);
}

const browser = await launchBrowser();

// ============================================================================
// 1. The arm: blocked, restored, and the same walk with the feature off.
// ============================================================================
{
  const page = await newPage(browser, { width: W, height: H });
  logPageErrors(page);
  await page.goto(BASE, { waitUntil: 'load' });
  await whenPlaying(page);
  await probe(page, '__dbgAdvance', 2);

  const start = await probe(page, '__dbgPlayerPos');
  const open = await probe(page, '__dbgOcclusion');
  check('openGround', open.arm > open.armWanted - 0.1, {
    arm: +open.arm.toFixed(2), armWanted: +open.armWanted.toFixed(2),
    why: 'nothing in the way: the arm is the length the zoom asked for',
  });

  const found = await findWall(page);
  results.wall = found && {
    x: found.box.x, z: found.box.z, hx: found.box.hx, hz: found.box.hz,
    rise: +(found.box.top - found.box.ground).toFixed(2),
  };
  if (!found) {
    check('foundWall', false, { why: 'no tall settlement collider near spawn' });
  } else {
    const spot = found.spot;
    await standAt(page, spot);
    // The hero has to be on the GROUND for the measurement to mean anything;
    // see findWall. Asserted rather than assumed, because a probe that quietly
    // measured a rooftop is a probe that passes for the wrong reason.
    const here = await probe(page, '__dbgPlayerPos');
    const { ground } = await probe(page, '__dbgSurfaceY', spot.x, spot.z);
    check('standsOnGround', Math.abs(here.y - ground) < 0.6, {
      heroY: +here.y.toFixed(2), ground,
      why: 'backed into the wall from open ground, not from on top of one',
    });
    const blocked = await probe(page, '__dbgOcclusion');
    check('pullsIn', blocked.arm < blocked.armWanted - 1, {
      spot,
      arm: +blocked.arm.toFixed(2), armWanted: +blocked.armWanted.toFixed(2),
      why: 'a wall behind the hero shortens the arm',
    });

    // Back to where he started, which this section already measured as clear.
    await page.evaluate((x, z) => window.__dbgTp(x, z), start.x, start.z);
    await probe(page, '__dbgAdvance', 3);
    const back = await probe(page, '__dbgOcclusion');
    check('restores', back.arm > back.armWanted - 0.2, {
      arm: +back.arm.toFixed(2), armWanted: +back.armWanted.toFixed(2),
      why: 'the zoom the player chose comes back once the wall is gone',
    });
    results.blockedSpot = spot;
  }
  await page.close();
}

// The control: the same hero, at the same place, against the same wall, with
// the camera forbidden to give way. Without this, `pullsIn` could be measuring
// a camera that shortens its arm for any reason at all.
if (results.blockedSpot) {
  const page = await newPage(browser, { width: W, height: H });
  logPageErrors(page);
  await page.goto(`${BASE}&occlude=0`, { waitUntil: 'load' });
  await whenPlaying(page);
  await page.evaluate((x, z) => window.__dbgTp(x, z),
    results.blockedSpot.x, results.blockedSpot.z);
  await probe(page, '__dbgAdvance', 3);
  const off = await probe(page, '__dbgOcclusion');
  check('occludeOffKeepsArm', off.arm > off.armWanted - 0.1, {
    arm: +off.arm.toFixed(2), armWanted: +off.armWanted.toFixed(2),
    strength: off.strength,
    why: '?occlude=0 is a real off: the arm stays inside the wall',
  });
  check('occludeOffKillsCut', off.strength === 0, {
    strength: off.strength, why: 'and the cut-away tube is switched off with it',
  });
  await page.close();
}

// ============================================================================
// 2. The cut, in pixels, with the arm held still.
// ============================================================================
{
  const page = await newPage(browser, { width: W, height: H });
  logPageErrors(page);
  await page.goto(STILL, { waitUntil: 'load' });
  await whenPlaying(page);
  await probe(page, '__dbgAdvance', 2);

  /** Photograph the frame with the cut on, then with it off, and diff. */
  async function cutPair() {
    // NO `__dbgAdvance` between the two photographs — `__dbgOcclude` writes the
    // uniform through itself, so the world is frozen and the only thing that
    // changed between them is the cut. See the hook in src/main.ts.
    const on = await probe(page, '__dbgOcclusion');
    await probe(page, '__dbgOcclude', 1);
    const a = await pixels(page);
    await probe(page, '__dbgOcclude', 0);
    const off = await probe(page, '__dbgOcclusion');
    const b = await pixels(page);
    return { changed: diff(a, b), armOn: on.arm, armOff: off.arm, tube: on };
  }

  // THE NOISE FLOOR, and the reason the number below means anything. Standing
  // where the probe booted, the tube runs through open camp air, so the cut has
  // nothing to take and whatever difference is left is the game refusing to
  // render twice the same: the frame loop simulates in real time between the
  // two screenshots, so a fire flickers and someone walks past. Measured at
  // 2-3% of the window, which is exactly why the signal below has to be an
  // order of magnitude larger rather than merely non-zero.
  const floor = await cutPair();
  check('noiseFloorIsSane', floor.changed < 0.05, {
    changed: floor.changed,
    why: 'two frames of a live world differ a little; this bounds how much',
  });

  // A CANOPY, not a wall, and that is the point of this section. The arm
  // deliberately ignores crowns (see ThirdPersonCamera's occlusion note), so
  // standing under an oak is the one case where the cut is the ONLY mechanism
  // that can put the hero back on screen — photographed with it off, the frame
  // is a wall of leaves with no character anywhere in it.
  // Walk the candidates until one leaves the arm with something to work over.
  // A crown whose BOLE is also right behind the hero clamps the arm to its 1.5
  // minimum, and a 1.5-unit tube has almost nothing in it — the cut is real
  // there and simply small, which would make this a test of where a tree
  // happened to grow. `arm > 2.5` is the condition for a fair photograph, and
  // the spot that met it is reported so the reading can be reproduced.
  let tree = null;
  let under = null;
  for (const cand of await findCanopies(page)) {
    await standAt(page, cand.spot);
    const shot = await cutPair();
    if (shot.armOn <= 2.5) continue;
    tree = cand;
    under = shot;
    break;
  }
  results.canopy = tree;
  if (!tree) {
    check('cutsAway', false, { why: 'no tree canopy within reach of spawn' });
  } else {
    check('cutHoldsTheArm', Math.abs(under.armOn - under.armOff) < 0.05, {
      armOn: +under.armOn.toFixed(3), armOff: +under.armOff.toFixed(3),
      why: 'the pixel pair differs by the cut alone, not by a camera move',
    });
    check('cutsAway', under.changed > 0.08 && under.changed > floor.changed * 5, {
      changed: under.changed, noiseFloor: floor.changed,
      tube: { radius: under.tube.radius, length: +under.tube.length.toFixed(2) },
      why: 'foliage standing on the camera-to-hero segment is stippled out',
    });
  }
  await page.close();
}

results.failures = failures;
console.log(JSON.stringify(results, null, 2));
await browser.close();
process.exit(failures ? 1 : 0);
