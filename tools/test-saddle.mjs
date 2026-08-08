// Verifies GETTING ON AND GETTING OFF A GROUND BEAST IN MID-AIR — issue #125,
// which is the same defect at both ends of the ride: the terrain far below was
// treated as where a body GOES rather than as a bound on the altitude it has,
// so each half teleported the hero to the ground in a single frame.
//
// Usage: bun tools/test-saddle.mjs        (dev server must be up)
//
// The two are one rule now (`transferY` in player/mount.ts), so one guard
// covers both — a family with a single mechanism does not get a test for
// whichever half was reported.
//
// Every section is a PAIR, because either half alone passes a build with the
// opposite defect:
//
//  * Dismounting in the air he must stay at the saddle and keep falling. Alone,
//    that passes where the step-off never takes ground at all — the hero would
//    drop a body-height every time he got off on flat dirt.
//  * On the ground he must step down ONTO the ground. Alone, that is the build
//    the issue was filed against.
//  * Mounting in the air the animal must come to HIM and fall with him, rather
//    than arriving on the terrain — or hanging in the sky, which is what an
//    unbounded "meet him where he is" would give.
//
// Exits non-zero on failure.
import { launchBrowser, newPage, wait } from './browser.mjs';
import { BASE as HOST } from './target.mjs';

const URL = `${HOST}/?menu=0&fs=0&vol=0`;
const browser = await launchBrowser();
const page = await newPage(browser, { width: 1280, height: 800 });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));

await page.goto(URL, { waitUntil: 'load' });
await page.waitForSelector('canvas');
// Readiness gate rather than a fixed sleep: __dbgAdvance steps no slices until
// the game is `playing`, and a run that started early would measure nothing.
for (let i = 0; i < 60; i++) {
  const b = await page.evaluate(() => window.__dbgBoot?.());
  if (b?.playing) break;
  await wait(250);
}

const pos = () => page.evaluate(() => window.__dbgPlayerPos());
const mnt = () => page.evaluate(() => window.__dbgMount());
const advance = (s) => page.evaluate((n) => window.__dbgAdvance(n), s);
const groundAt = (x, z) =>
  page.evaluate(([a, b]) => window.__dbgSurfaceY(a, b).ground, [x, z]);

const results = {};
const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); };

// A WALKER, bonded through the developer door. The claim is about `locomotion:
// 'ground'` specifically — a flyer has always left the saddle where it was, and
// tools/test-companion.mjs already measures that path.
await page.evaluate(() => window.__dbgGrantBeast('emberfox'));
await wait(300);

const said = await page.evaluate(() => window.__dbgRide('emberfox'));
await wait(300);
{
  const m = await mnt();
  results.mount = { said, mounted: m.mounted, locomotion: m.locomotion };
  if (!m.mounted || m.locomotion !== 'ground') {
    console.error(`could not ride a ground beast (${said}) — nothing below is a test`);
    await browser.close();
    process.exit(1);
  }
}

// ---------- in the air: he stays at the saddle and keeps falling ----------
{
  const p = await pos();
  const ground = await groundAt(p.x, p.z);
  await page.evaluate(([x, z, y]) => window.__dbgTp(x, z, y), [p.x, p.z, ground + 30]);
  // Long enough to be unmistakably falling (vy < 0), short enough that 30 units
  // of headroom are still there to fall through.
  await advance(0.4);

  const before = await mnt();
  const off = await page.evaluate(() => window.__dbgRide('off'));
  const at = await pos();
  results.air = { ground, mountY: before.bodyY, off, dismountedAt: +at.y.toFixed(2) };

  check(before.bodyY - ground > 20,
    `the fall only reached ${(before.bodyY - ground).toFixed(2)} over the ground`);
  // THE ISSUE, as one number: the drop taken in the dismount frame itself.
  check(at.y > before.bodyY - 1.5,
    `dismounting mid-air dropped the hero from ${before.bodyY} to ${at.y.toFixed(2)} — issue #125`);
  check(at.y - ground > 20,
    `the hero was put ${(at.y - ground).toFixed(2)} over the ground by the dismount`);

  // ...and he is FALLING, not hanging there. The other way this could pass.
  await advance(0.5);
  const mid = await pos();
  results.air.afterHalfSecond = +mid.y.toFixed(2);
  check(mid.y < at.y - 0.5,
    `the hero did not continue falling (${at.y.toFixed(2)} -> ${mid.y.toFixed(2)})`);

  await advance(6);
  const landed = await pos();
  results.air.landed = +landed.y.toFixed(2);
  check(Math.abs(landed.y - (await groundAt(landed.x, landed.z))) < 2,
    `the hero never reached the ground (rested at ${landed.y.toFixed(2)})`);
}

// ---------- mounting up mid-air: the animal comes to HIM ----------
// The other half of the same rule (`transferY`): the floor bounds the altitude
// a body has, it is not where the body goes. A walker mounted during a fall
// used to assign the floor outright and land the pair of them instantly.
{
  const p = await pos();
  const ground = await groundAt(p.x, p.z);
  await page.evaluate(([x, z, y]) => window.__dbgTp(x, z, y), [p.x, p.z, ground + 30]);
  await advance(0.4);

  const before = await pos();
  const said2 = await page.evaluate(() => window.__dbgRide('emberfox'));
  const m = await mnt();
  results.mountInAir = {
    ground, before: +before.y.toFixed(2), said: said2, bodyY: m.bodyY, y: m.y,
  };
  check(m.mounted === true, `could not mount during the fall: ${said2}`);
  check(m.bodyY > before.y - 1.5,
    `mounting mid-air dropped the walker from ${before.y.toFixed(2)} to ${m.bodyY} — issue #125`);

  // ...and the pair of them are FALLING, not parked in the sky.
  await advance(0.5);
  const mid = await mnt();
  results.mountInAir.afterHalfSecond = mid.bodyY;
  check(mid.bodyY < m.bodyY - 0.5,
    `the mounted fall stopped in mid-air (${m.bodyY} -> ${mid.bodyY})`);

  await advance(6);
  const landed = await mnt();
  results.mountInAir.landed = landed.bodyY;
  check(Math.abs(landed.bodyY - ground) < 2,
    `the mount never reached the ground (rested at ${landed.bodyY})`);
  await page.evaluate(() => window.__dbgRide('off'));
  await advance(0.2);
}

// ---------- on the ground: he still steps DOWN onto it ----------
// The other half of the bound. Without it "he stayed at the saddle" passes for a
// build that never takes ground at all.
{
  await page.evaluate(() => window.__dbgRide('emberfox'));
  await advance(0.5);
  const m = await mnt();
  const off = await page.evaluate(() => window.__dbgRide('off'));
  await advance(0.1);
  const at = await pos();
  const ground = await groundAt(at.x, at.z);
  results.flat = { mounted: m.mounted, off, at: +at.y.toFixed(2), ground };
  check(m.mounted === true, `could not re-mount on flat ground: ${off}`);
  // A step off, not a fall: the hero's feet are at the ground beside the mount.
  check(Math.abs(at.y - ground) < 1.2,
    `the step-off left the hero ${(at.y - ground).toFixed(2)} off the ground beside the mount`);
}

console.log(JSON.stringify({ ...results, fails }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
