// Verifies THE FLYERS' GROUND CONTACT BLOB IS ON THE GROUND — issue #134, where
// a mount climbing away trailed a dark disc through the sky at a fixed drop
// under its belly, because the blob was parented at `-HOVER` and never asked how
// far the ground actually was.
//
// Usage: bun tools/test-flyshadow.mjs        (dev server must be up)
//
// BOTH HALVES, because either alone passes a build with the opposite defect:
//
//  * Near the ground the blob must be ON the ground and visible. Alone, that is
//    the build the issue was filed against.
//  * High in the air it must be gone. Alone, that passes a build with no
//    contact shadow at all, which is what contactshadow.ts exists to avoid.
//
// The reading is the blob's WORLD y against `__dbgSurfaceY`, not its local
// offset: mount form scales the rig root, so a local offset can be right and the
// shadow still float.
//
// Exits non-zero on failure.
import { launchBrowser, newPage, wait } from "./browser.mjs";
import { BASE as HOST } from "./target.mjs";

// `mounts=all` because riding is three story unlocks and a new character has
// none of them (src/core/flags.ts). This probe measures a RIDE, so it asks for
// the unlock at boot rather than driving it; tools/test-mounts.mjs is the one
// that leaves it off, because the lock is what it tests.
const URL = `${HOST}/?menu=0&fs=0&vol=0&mounts=all`;
const browser = await launchBrowser();
const page = await newPage(browser, { width: 1280, height: 800 });
page.on("pageerror", (e) => console.error("[pageerror]", e.message));

await page.goto(URL, { waitUntil: "load" });
await page.waitForSelector("canvas");
for (let i = 0; i < 60; i++) {
  const b = await page.evaluate(() => window.__dbgBoot?.());
  if (b?.playing) {
    break;
  }
  await wait(250);
}

const pos = () => page.evaluate(() => window.__dbgPlayerPos());
const advance = (s) => page.evaluate((n) => window.__dbgAdvance(n), s);
const groundAt = (x, z) => page.evaluate(([a, b]) => window.__dbgSurfaceY(a, b), [x, z]);
/**
 * THE RIDDEN body, and only it. `__dbgBeastAnim` reports every live actor,
 * including ones parked at the origin that no slice has posed yet — their blob
 * sits at the drop the rig was built with, which is exactly the reading this
 * probe must not mistake for a shadow in the world.
 */
const mount = async () => {
  const all = await page.evaluate(() => window.__dbgBeastAnim());
  return all.find((b) => b.ridden && b.blob) ?? null;
};

const results = {};
const fails = [];
const check = (ok, msg) => {
  if (!ok) {
    fails.push(msg);
  }
};

// A FLYER, bonded and ridden through the developer door. Galebird is the roster's
// plainest one — a blob, a wingbeat, no hover quirks of its own.
await page.evaluate(() => window.__dbgGrantBeast("galebird"));
await wait(300);
const said = await page.evaluate(() => window.__dbgRide("galebird"));
await wait(300);
{
  const m = await page.evaluate(() => window.__dbgMount());
  results.mount = { said, mounted: m.mounted, locomotion: m.locomotion };
  if (!m.mounted || m.locomotion !== "flying") {
    console.error(`could not ride a flyer (${said}) — nothing below is a test`);
    await browser.close();
    process.exit(1);
  }
}

// ---------- cruising just off the ground: the shadow is ON the ground ----------
{
  await advance(0.6);
  const p = await pos();
  const ground = (await groundAt(p.x, p.z)).ground;
  const b = await mount();
  results.low = b
    ? { alt: b.altitude, blobY: b.blob.y, ground, opacity: b.blob.opacity, visible: b.blob.visible }
    : null;
  check(b !== null, "the ridden flyer has no contact blob");
  if (b) {
    // Half a unit of slack: the terrain the blob sits over is sampled at the
    // BEAST's column and the mount is a hair ahead of it while cruising.
    check(
      Math.abs(b.blob.y - ground) < 0.5,
      `blob is not on the ground while cruising (blob ${b.blob.y.toFixed(2)} vs ground ${ground.toFixed(2)})`,
    );
    check(
      b.blob.visible && b.blob.opacity > 0.15,
      `blob faded out at cruise height (opacity ${b.blob?.opacity})`,
    );
  }
}

// ---------- high above it: no disc in the sky ----------
{
  const p = await pos();
  const ground = (await groundAt(p.x, p.z)).ground;
  await page.evaluate(([x, z, y]) => window.__dbgTp(x, z, y), [p.x, p.z, ground + 30]);
  await advance(0.4);
  const b = await mount();
  const p2 = await pos();
  results.high = b
    ? {
        heroY: p2.y,
        alt: b.altitude,
        blobY: b.blob.y,
        opacity: b.blob.opacity,
        visible: b.blob.visible,
      }
    : null;
  check(b !== null, "the flyer went away when its rider was lifted");
  if (b) {
    check(b.altitude > 12, `the mount did not stay up (altitude ${b.altitude?.toFixed(2)})`);
    check(
      !b.blob.visible || b.blob.opacity < 0.01,
      `a shadow is still drawn 30 units up (visible ${b.blob.visible}, opacity ${b.blob.opacity})`,
    );
  }
}

console.log(JSON.stringify({ results, fails }, null, 2));
await browser.close();
if (fails.length) {
  for (const f of fails) {
    console.error("FAIL:", f);
  }
  process.exit(1);
}
console.log("OK — the contact blob lies on the ground and fades with altitude");
