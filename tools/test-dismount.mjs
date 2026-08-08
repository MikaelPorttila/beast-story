// Verifies WHERE A RIDER LANDS WHEN HE GETS OFF — issue #125: dismounting a
// GROUND beast in mid-air teleported the hero to the terrain far below in a
// single frame, instead of leaving him in the saddle's place to finish the fall.
//
// Usage: bun tools/test-dismount.mjs        (dev server must be up)
//
// The defect was one comparison. The step-off asks "is the column beside the
// mount no higher than my feet plus a step?", which is trivially true for every
// column BELOW the mount — so thirty units up it read the ground as a step down
// and took it. The fix bounds the step in both directions (MOUNT_STEP_DOWN in
// player/mount.ts), and this probe asserts BOTH halves of that bound, because
// neither means anything alone:
//
//  * In the air he must stay at the saddle and keep falling. Alone, that passes
//    in a build where the step-off never takes ground at all — the hero would
//    then drop a body-height every time he got off on flat dirt, which is the
//    opposite defect.
//  * On the ground he must step down ONTO the ground. Alone, that is the build
//    the issue was filed against.
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
