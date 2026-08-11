// Verifies that RIDING IS LOCKED UNTIL THE STORY UNLOCKS IT, and that the bag
// says so.
//
// Usage: bun tools/test-mounts.mjs        (dev server must be up)
//
// THE ONE PROBE THAT BOOTS WITHOUT `mounts=`. Every other tool that rides
// something passes `mounts=all` (or calls `unlockMounts` from the harness)
// precisely so the lock is not in the way of what it is measuring; this file is
// testing the lock, so it has to meet it.
//
// EVERY SECTION IS A PAIR, for the reason the rest of tools/ gives — one arm
// alone passes against a broken build:
//
//   * A held F on a fresh character must NOT mount, AND the same held F after
//     the unlock must. The first alone passes a build where mounting is broken
//     outright; the second alone passes one where nothing was ever locked.
//   * Unlocking GROUND must let a walker be ridden AND must leave a flyer
//     refused. Without the second half, `MountUnlocks.allows` returning true for
//     everything passes — which is the shape the bug would actually take.
//   * The badge must be drawn for all three kinds AND be lit for exactly the
//     unlocked ones. A strip that lights everything and a strip that lights
//     nothing both pass "there are three badges".
//
// It asserts through the DOOR THE PLAYER USES wherever it can: the refusals are
// measured by holding F beside the lead beast, not by reading the predicate, so
// a gate wired to nothing fails here rather than passing a unit test of itself.
//
// Exits non-zero on failure.
import { launchBrowser, newPage, wait } from './browser.mjs';
import { BASE as HOST } from './target.mjs';

// NO `mounts=` — see the header. `nostore=1` for the usual reason: this probe
// has no business leaving save records on the machine it runs on.
const URL = `${HOST}/?menu=0&fs=0&vol=0&nostore=1`;
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

const mnt = () => page.evaluate(() => window.__dbgMount());
const inv = () => page.evaluate(() => window.__dbgInventory());
const advance = (s) => page.evaluate((n) => window.__dbgAdvance(n), s);
const unlock = (kind, on) =>
  page.evaluate(([k, o]) => window.__dbgUnlockMount(k, o), [kind, on]);
/**
 * Put a bonded beast in the lead slot, which is the beast F offers.
 *
 * THROUGH THE INVENTORY'S OWN ACTION and NOT through `__dbgRide`, which is the
 * other way to choose a lead and would ruin every measurement here: that hook
 * seats the beast AND climbs on, so with the unlock granted the hero would
 * already be mounted before F was touched — and the first thing a held F does
 * from the saddle is get off.
 */
const lead = (id) =>
  page.evaluate((s) => window.__dbgInvAction(`beast:${s}`, 'setLead'), id);

const results = {};
const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); };

/**
 * HOLD F FOR LONGER THAN THE HOLD TAKES, and report what came of it.
 *
 * 1.4 s against MOUNT_HOLD's 0.8 — comfortably over, without being so long that
 * a refusal's toast has faded before the reading. The hold is accumulated in
 * SIMULATED time (`__dbgAdvance`), so this measures the same number of slices on
 * a software rasteriser and on a 165 Hz host.
 */
async function holdF() {
  await page.keyboard.down('KeyF');
  await advance(1.4);
  const m = await mnt();
  await page.keyboard.up('KeyF');
  await advance(0.2);
  // Whatever happened, get back off, so the next section starts where this one
  // did. A no-op when the hold was refused.
  await page.evaluate(() => window.__dbgRide('off'));
  await advance(0.1);
  return m;
}

// A WALKER AND A FLYER, bonded through the developer door. Two kinds because
// the second section's claim is that an unlock is per-KIND, and one beast
// cannot say that.
await page.evaluate(() => window.__dbgGrantBeast('emberfox'));
await page.evaluate(() => window.__dbgGrantBeast('galebird'));
await advance(0.3);

// ---------- 1. a fresh character has nothing, and F says so ----------
{
  await lead('emberfox');
  const before = await mnt();
  const held = await holdF();
  results.locked = {
    unlocked: before.unlocked,
    refusal: before.refusal,
    mountedOnHold: held.mounted,
    holdProgress: held.hold,
  };
  check(Array.isArray(before.unlocked) && before.unlocked.length === 0,
    `a new character started with ${JSON.stringify(before.unlocked)} unlocked`);
  check(before.refusal === 'locked',
    `the lead beast was refused with "${before.refusal}", not "locked"`);
  check(held.mounted === false, 'a 1.4 s hold of F mounted a locked beast');
  // The BAR, not just the outcome: a hold that filled and then failed to mount
  // is a different bug from one that was refused, and only this tells them
  // apart. A refusal zeroes the fill every slice (see `update` in mount.ts).
  check(held.hold === 0,
    `a refused hold still filled the ring to ${held.hold} — it should never leave 0`);
}

// ---------- 2. one unlock is one KIND ----------
{
  const said = await unlock('ground', true);
  await lead('emberfox');
  const walker = await holdF();
  await lead('galebird');
  const beforeFlyer = await mnt();
  const flyer = await holdF();
  results.perKind = {
    said,
    walkerMounted: walker.mounted,
    walkerLocomotion: walker.locomotion,
    flyerRefusal: beforeFlyer.refusal,
    flyerMounted: flyer.mounted,
  };
  check(walker.mounted === true && walker.locomotion === 'ground',
    `unlocking ground did not let a walker be ridden (${said})`);
  check(flyer.mounted === false,
    'unlocking ground also let a flyer be ridden — the unlock is not per kind');
  check(beforeFlyer.refusal === 'locked',
    `the flyer was refused with "${beforeFlyer.refusal}", not "locked"`);
}

// ---------- 3. the badges in the bag ----------
{
  await page.keyboard.press('KeyI');
  await page.waitForSelector('.bs-inv .mt', { timeout: 5000 });
  const partial = await inv();
  const badges = partial.panel.mountBadges;

  // The tooltip, on TEXT — an empty box that opens on hover would pass any "is
  // it visible" test, and the sentence a LOCKED badge carries is the whole
  // reason this feature has a hover at all. `page.hover`, not a bare mouse
  // move: only the real gesture synthesises the pointerover the panel listens
  // for (see the same note in tools/test-inventory.mjs).
  await page.hover('.bs-inv .mt[data-tip="flying"]');
  await wait(150);
  const lockedTip = (await inv()).panel.tip;
  await page.hover('.bs-inv .mt[data-tip="ground"]');
  await wait(150);
  const unlockedTip = (await inv()).panel.tip;

  results.badges = {
    kinds: badges.map((b) => b.kind),
    lit: badges.filter((b) => b.on).map((b) => b.kind),
    model: partial.mounts,
    lockedTip,
    unlockedTip,
  };
  check(badges.length === 3,
    `the bag drew ${badges.length} mount badges, not three`);
  check(badges.filter((b) => b.on).length === 1 && badges.find((b) => b.on)?.kind === 'ground',
    `the lit badges were ${JSON.stringify(badges.filter((b) => b.on).map((b) => b.kind))}`
    + ' with only ground unlocked');
  // The two halves of the hover, and they must not be the same sentence: a
  // tooltip that ignored the unlocked flag would pass "there is a tooltip".
  check(!!lockedTip && /story progress/i.test(lockedTip),
    `a locked badge's tooltip read "${lockedTip}"`);
  check(!!unlockedTip && !/story progress/i.test(unlockedTip),
    `an unlocked badge's tooltip read "${unlockedTip}"`);

  // AND IT FOLLOWS A CHANGE MADE FROM ELSEWHERE. The panel is open; the console
  // door is what the F3 rows use, so this is the seam that keeps the two
  // surfaces in step.
  await unlock('all', true);
  await wait(150);
  const all = await inv();
  results.badges.litAfterAll = all.panel.mountBadges.filter((b) => b.on).map((b) => b.kind);
  check(all.panel.mountBadges.every((b) => b.on),
    `unlocking everything left ${JSON.stringify(results.badges.litAfterAll)} lit with the`
    + ' panel already open');
  await page.keyboard.press('KeyI');
  await advance(0.2);
}

// ---------- 4. locking takes it back ----------
// The other direction, and it is not a formality: the debug door writes through
// the same `set` a quest eventually will, and a one-way switch would hide a
// `MountUnlocks.set` that only ever adds.
{
  await unlock('all', false);
  await lead('emberfox');
  const after = await mnt();
  const held = await holdF();
  results.relock = { unlocked: after.unlocked, refusal: after.refusal, mounted: held.mounted };
  check(after.unlocked.length === 0, `re-locking left ${JSON.stringify(after.unlocked)}`);
  check(held.mounted === false, 'a re-locked beast could still be ridden');
}

console.log(JSON.stringify({ ...results, fails }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
