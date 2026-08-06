// Verifies LIGHT TRAVEL — that a companion whose owner has flown out of reach
// travels along with him and lands beside him again (issue #70).
//
// Usage: bun tools/test-companion.mjs        (dev server must be up)
//
// The defect this exists for is invisible to every other probe in tools/,
// because they all drive a hero standing on the ground: `TELEPORT_DIST` measures
// x and z only, so a hero a hundred units up is nine units away by the only
// measure a companion ever took, and both beasts pile up on the meadow directly
// underneath animating a follow they can never complete.
//
// The shape of the run is a PAIR, twice, and neither half means anything alone:
//
//  * On the ground the companions must be BESIDE him and NOT in transit. Without
//    it, "in transit while flying" passes just as well in a build where they are
//    permanently light and never come back — which is the opposite defect and
//    the worse one, since a beast that never re-forms can never fight.
//  * In the air they must be in transit AND their reported distance must stay
//    small: "they went into transit" alone passes for a beast that dissolved
//    where it stood and stayed there, which is the bug with a new coat of paint.
//
// Then the landing, which is the actual player-facing request: dismount, and
// within a couple of seconds both are back on the ground, out of transit, at the
// hero's own height.
//
// Issue #91 adds the inverse: a flying companion remains a visible body during
// a skyfall, and mounting it preserves that altitude instead of landing the
// rider invisibly on the terrain.
//
// Exits non-zero on failure.
import { launchBrowser, newPage, wait } from './browser.mjs';
import { BASE as HOST } from './target.mjs';

const URL = `${HOST}/?menu=0&fs=0`;
const browser = await launchBrowser();
const page = await newPage(browser, { width: 1280, height: 800 });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));

await page.goto(URL, { waitUntil: 'load' });
await page.waitForSelector('canvas');
await wait(5000);
await page.focus('canvas').catch(() => {});

const comp = () => page.evaluate(() => window.__dbgCompanions?.());

/** Type one line at the dev console. The only way to stage a mount. */
async function cmd(line) {
  await page.keyboard.press('Backquote');
  await page.waitForSelector('.bs-console-input', { visible: true });
  await page.type('.bs-console-input', line);
  await page.keyboard.press('Enter');
  await wait(400);
  await page.keyboard.press('Backquote');
  await wait(400);
}

const results = {};
const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); };

const first = await comp();
if (!first) {
  console.error('no __dbgCompanions hook — nothing to measure');
  await browser.close();
  process.exit(1);
}

// ---------- on the ground: bodies, beside him ----------
// The CONTROL. Every assertion below is about a beast disappearing and coming
// back; this is the one that says there was something there to begin with.
{
  await wait(1200);
  const c = await comp();
  results.onFoot = c;
  for (const b of c.beasts) {
    check(!b.transit, `${b.role} is travelling as light while the hero is standing still`);
    check(b.d < 8, `${b.role} is ${b.d} units away on flat ground`);
    check(Math.abs(b.dy) < 3, `${b.role} is ${b.dy} off the hero's height on flat ground`);
  }
}

// ---------- skyfall: a flyer stays physical and mounts here ---------------
{
  const at = await comp();
  await page.evaluate(([x, z, y]) => window.__dbgTp(x, z, y), [
    at.player.x, at.player.z, at.ground + 30,
  ]);
  await wait(800);
  const falling = await comp();
  const flyer = falling.beasts.find((b) => b.id === 'galebird');
  results.skyfall = { beforeMount: falling, flyer };
  check(falling.player.y - falling.ground > 16,
    `the skyfall only started ${(falling.player.y - falling.ground).toFixed(2)} above ground`);
  check(!!flyer, 'Galebird is not active during the skyfall');
  if (flyer) {
    check(!flyer.transit, 'Galebird converted to light during an ordinary skyfall');
    check(flyer.drawn, 'Galebird body is hidden during an ordinary skyfall');
    check(Math.abs(flyer.dy) < 8,
      `Galebird did not follow the fall altitude (${flyer.dy} units off the hero)`);
  }

  const highY = falling.player.y;
  const said = await page.evaluate(() => window.__dbgRide('galebird'));
  await wait(300);
  const mounted = await page.evaluate(() => window.__dbgMount());
  const mountedParty = await comp();
  const ridden = mountedParty.beasts.find((b) => b.id === 'galebird');
  results.skyfall.afterMount = { said, mount: mounted, ridden };
  check(mounted.mounted && mounted.beast === 'galebird', `could not mount during skyfall: ${said}`);
  check(mounted.bodyY > highY - 2,
    `mounting dropped the flyer from ${highY.toFixed(2)} to ${mounted.bodyY}`);
  check(!!ridden?.drawn, 'the skyfall mount is not drawn');
  check(!ridden?.transit, 'the ridden Galebird stayed in light transit');

  await page.evaluate(() => window.__dbgRide('off'));
  for (let i = 0; i < 20; i++) {
    await wait(300);
    const c = await comp();
    if (c.player.y - c.ground < 1) break;
  }
}

// ---------- climb out of reach ----------
await cmd('/mount galebird');
{
  const m = await page.evaluate(() => window.__dbgMount?.());
  results.mount = { mounted: m?.mounted ?? false, locomotion: m?.locomotion ?? null };
  check(m?.mounted === true, 'could not mount the galebird — the rest of the run means nothing');
  check(m?.locomotion === 'flying', `mounted something that does not fly: ${m?.locomotion}`);
}
{
  await page.keyboard.down('Space');
  await wait(4000);
  await page.keyboard.up('Space');
  await wait(600);

  const c = await comp();
  results.flying = c;
  // The climb has to actually clear BEAM_RISE (13) or nothing below is a test.
  check(c.player.y - c.ground > 16,
    `the climb only reached ${(c.player.y - c.ground).toFixed(2)} over the ground`);
  for (const b of c.beasts) {
    // The mounted beast is under the rider's reins and never follows anything;
    // it is skipped here and in every airborne section below.
    if (b.ridden) continue;
    check(b.transit, `${b.role} did not leave: still a body ${b.dy} units below the hero`);
    // The half that says it TRAVELLED rather than merely vanished. A companion
    // in transit is pinned to its own station point beside the owner, so this is
    // the station offset (~2 units) and not a leash slowly closing.
    check(b.d < 5, `${b.role} is in transit but ${b.d} units away — it stayed behind`);
    check(Math.abs(b.dy) < 4, `${b.role} is in transit but ${b.dy} off the hero's height`);
  }
}

// ---------- hold the altitude: they must STAY with him ----------
// A beam that landed the beast on the first slice its owner drifted over a hill
// would pass everything above. Fly on, then read again.
{
  await page.keyboard.down('KeyW');
  await wait(2500);
  await page.keyboard.up('KeyW');
  await wait(400);
  const c = await comp();
  results.cruising = c;
  for (const b of c.beasts) {
    if (b.ridden) continue;
    if (c.player.y - c.ground > 16) {
      check(b.transit, `${b.role} re-formed in mid-air, ${(c.player.y - c.ground).toFixed(2)} up`);
      check(b.d < 5, `${b.role} fell behind while cruising (${b.d} units)`);
    }
  }
}

// ---------- land: they come back ----------
{
  await cmd('/mount off');
  // POLLED rather than slept, because how long a fall from cruising altitude
  // takes is a property of where the flight ended: settle when the hero's own
  // height stops moving, then read once. A fixed wait reads him mid-drop.
  let prev = null, settled = null;
  for (let i = 0; i < 24; i++) {
    await wait(400);
    const y = (await comp()).player.y;
    if (prev !== null && Math.abs(y - prev) < 0.02) { settled = y; break; }
    prev = y;
  }
  await wait(800);   // BEAM_FLASH + the poof scale-in
  const c = await comp();
  results.landed = { settled, ...c };
  check(settled !== null, 'the hero never stopped falling');
  for (const b of c.beasts) {
    check(!b.transit, `${b.role} is STILL travelling as light after the hero landed — issue #70`);
    check(b.d < 8, `${b.role} landed ${b.d} units away instead of beside him`);
    // BEAM_LAND is 4.5, and a hero who came down on a canopy or a terrace is
    // legitimately that far over the ground his companion stands on. What is
    // being asserted is that it is a DROP and not a sky the beast is stuck under.
    check(Math.abs(b.dy) < 6, `${b.role} landed ${b.dy} off the hero's height`);
  }
}

console.log(JSON.stringify({ ...results, fails }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
