// Verifies leaving the saddle of a GROUND mount in mid-air (src/player/mount.ts,
// `dismount`).
//
// Usage: bun tools/test-mount-air.mjs        (dev server must be up)
//
// This is the guard for issue #125: falling on a ground beast and dismounting
// teleported the rider straight down to the terrain. The step-off test asked
// only "is the ground under the step-off column at most a mount's step ABOVE the
// saddle", which is trivially true when the ground is thirty units below — so
// the branch meant for stepping down beside the animal fired in open air.
//
// Both halves are asserted, because "he did not teleport" alone would also pass
// if the step-off had stopped working entirely:
//   air     dismounted at altitude: the hero keeps the saddle's height and is
//           still falling a moment later.
//   ground  dismounted standing on the terrain: the hero is placed ON it, the
//           step-off that has always been the point of that branch.
//
// Exits non-zero.
import { launchBrowser, newPage, wait, whenPlaying } from './browser.mjs';
import { BASE as HOST } from './target.mjs';

const browser = await launchBrowser();
const page = await newPage(browser, { width: 960, height: 600 });
page.on('pageerror', (e) => console.error('[page]', e.message));

// `menu=0`: this probe measures the world and drives no menu.
await page.goto(`${HOST}/?menu=0&vol=0&warmup=0`, { waitUntil: 'load' });
await whenPlaying(page);
await wait(1500);

const results = {};
const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); };
const round = (v, n = 2) => +v.toFixed(n);

const mountState = () => page.evaluate(() => window.__dbgMount());
const pos = () => page.evaluate(() => window.__dbgPlayerPos());
const advance = (s) => page.evaluate((n) => window.__dbgAdvance(n), s);

// A beast to ride. Emberfox is the roster's plain GROUND walker, which is the
// locomotion the issue is about — a flyer leaves the saddle in the air by
// design and has always been the branch that works.
await page.evaluate(() => {
  window.__dbgGrantBeast('emberfox');
  window.__dbgRide('emberfox');
});
await wait(300);

const seated = await mountState();
check(seated.mounted && seated.locomotion === 'ground',
  `expected to be riding a ground beast, got ${seated.beast} / ${seated.locomotion}`);

// -- air: fall, then get off ------------------------------------------------
// Thirty units up is far past any step-down a dismount may take, and past the
// terrain's own terraces, so the only thing that can put the hero on the ground
// here is the bug.
const start = await pos();
const DROP = 30;
await page.evaluate((y) => {
  const p = window.__dbgPlayerPos();
  window.__dbgTp(p.x, p.z, window.__dbgMount().ground + y);
}, DROP);
// Half a second of fall, so he is demonstrably airborne and moving when the
// saddle is left — a dismount from a standstill at altitude would not tell us
// the velocity survived.
await advance(0.5);

const beforeAir = await mountState();
check(beforeAir.y > beforeAir.ground + 10,
  `mount should still be high up before the air dismount, y=${beforeAir.y} ground=${beforeAir.ground}`);

await page.evaluate(() => window.__dbgRide('off'));
const afterAir = await pos();
const airGround = beforeAir.ground;
results.air = {
  seatY: round(beforeAir.y),
  dismountY: round(afterAir.y),
  ground: round(airGround),
  keptHeight: round(afterAir.y - beforeAir.y),
};
// The hero leaves the saddle where the saddle was. Two units of slack covers
// the seat offset — `y` is the RIDER's height and the dismount places him at the
// ANIMAL's, which is 0.91 lower on an emberfox and more on a taller beast. The
// failure this guards against is a jump of twenty-odd units.
check(Math.abs(afterAir.y - beforeAir.y) < 2,
  `air dismount moved the hero ${round(afterAir.y - beforeAir.y)} units (issue #125: teleported to the ground)`);
check(afterAir.y > airGround + 10,
  `air dismount left the hero at ${round(afterAir.y)}, ground is ${round(airGround)}`);

// And he is still falling: the mount's downward speed came with him.
await advance(0.3);
const falling = await pos();
results.air.fellAfter = round(falling.y - afterAir.y);
check(falling.y < afterAir.y - 0.5,
  `hero did not continue falling after the air dismount (${round(falling.y - afterAir.y)} in 0.3 s)`);

// -- ground: the step-off still works ---------------------------------------
await page.evaluate(() => {
  window.__dbgRide('emberfox');
  const p = window.__dbgPlayerPos();
  window.__dbgTp(p.x, p.z);
});
await advance(0.5);
const beforeGround = await mountState();
check(beforeGround.mounted, 'expected to be remounted for the ground half');

await page.evaluate(() => window.__dbgRide('off'));
await advance(0.1);
const afterGround = await pos();
results.ground = {
  seatY: round(beforeGround.y),
  dismountY: round(afterGround.y),
  ground: round(beforeGround.ground),
};
// Placed on the surface, not left hanging: within a mount's step of the terrain
// under the saddle, which is what the step-off branch promises.
check(Math.abs(afterGround.y - beforeGround.ground) < 2,
  `ground dismount put the hero at ${round(afterGround.y)}, terrain is ${round(beforeGround.ground)}`);

results.startY = round(start.y);
console.log(JSON.stringify({ results, fails }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`FAIL (${fails.length})`);
  process.exit(1);
}
console.log('PASS');
