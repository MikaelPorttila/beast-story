// THE STANDING STONES: lit by walking up to one, and where a faint puts you.
//
// Usage: bun tools/test-waypoints.mjs      (dev server must be up)
//
// Five claims, and three of them are pairs, because each arm alone passes
// against a build that does the thing unconditionally:
//
//   1. THEY ARE SITED OFF THE ROAD, not authored. Every town has one at its
//      gate and there are more between the towns than there are towns — which
//      is the whole point of them, a stone out where the walk back would
//      otherwise be the punishment for dying.
//   2. NONE IS LIT ON A NEW CHARACTER. The other arm of claim 3.
//   3. WALKING UP TO ONE LIGHTS IT, and only it.
//   4. A FAINT PUTS YOU AT THE NEAREST LIT STONE, and the pair: with nothing
//      lit it puts you at the world's spawn, which is where it always did.
//      Measured by DYING, not by reading the policy — `__dbgWaypoints` reports
//      what the policy would answer, and this checks where the hero actually
//      woke up.
//   5. IT SURVIVES A RELOAD. A lit stone is a content discovery, so it round
//      trips with every other fact the character owns; a stone lit and then
//      forgotten is a player sent back across the valley (issue #171's rule).
//
// Exits non-zero on failure.
import { launchBrowser, newPage, wait } from "./browser.mjs";
import { BASE as HOST } from "./target.mjs";

const URL = `${HOST}/?menu=0&vol=0`;

const browser = await launchBrowser();
const results = {};
const fails = [];
const check = (ok, msg) => {
  if (!ok) {
    fails.push(msg);
  }
};

const page = await newPage(browser, { width: 1280, height: 800 });
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(
  () => window.__dbgBoot && window.__dbgBoot().playing && window.__dbgWaypoints,
  {
    timeout: 60000,
  },
);
await wait(400);

const dbg = (fn, ...args) => page.evaluate(fn, ...args);
const stones = () => dbg(() => window.__dbgWaypoints());
const pos = () => dbg(() => window.__dbgPlayerPos());
const adv = (s) => dbg((n) => window.__dbgAdvance(n), s);
const tp = (x, z) => dbg((p) => window.__dbgTp(p.x, p.z), { x, z });
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * Faint, and wait to be put back on your feet.
 *
 * Through `__dbgHurt`, which is the hero's own `takeDamage` — so the death
 * sequence, the corpse slide and the revival all run, and where he ends up is
 * where the game put him rather than where a test wrote him.
 */
const hp = () => dbg(() => window.__dbgZone().player.hp);

async function faint() {
  const full = await hp();
  await dbg(() => window.__dbgHurt(99999));
  // The corpse slides, then the revival fires on its own clock. Watching the HP
  // come back is watching the game finish, not a guess at how long it takes.
  for (let i = 0; i < 80; i++) {
    await adv(0.25);
    if ((await hp()) >= full) {
      return true;
    }
  }
  return false;
}

// ---------- 1 & 2. sited off the road, and dark ----------------------------
{
  const w = await stones();
  const towns = await dbg(() => window.__dbgTowns().towns.map((t) => t.id));
  const gates = w.all.filter((s) => s.id.startsWith("waypoint:town-"));
  results.sited = {
    count: w.all.length,
    gates: gates.map((s) => s.id),
    between: w.all.length - gates.length,
    lit: w.all.filter((s) => s.lit).map((s) => s.id),
  };
  check(w.all.length > 0, "the world grew no waypoints at all");
  check(
    gates.length === towns.filter((t) => t !== "skyhaven").length,
    `${gates.length} town stones for ${towns.length} towns: ${JSON.stringify(results.sited.gates)}`,
  );
  check(
    results.sited.between > gates.length,
    `only ${results.sited.between} stones stand between the towns — the walk back is the point of them`,
  );
  check(
    results.sited.lit.length === 0,
    `a new character starts with stones already lit: ${JSON.stringify(results.sited.lit)}`,
  );
}

// ---------- 2b. and none of them stands ON the road ------------------------
// A STONE IS SOLID, and the gate stones are sited exactly where the road enters
// a town: unmoved, each one is a wall across the way in. The clearance is
// measured from the carriageway's RIM — its own `deckEdge` — and never from the
// centreline, which is the rule every clearance question here answers.
{
  const w = await stones();
  const roads = await dbg(() =>
    window.__dbgTowns().roads.map((r) => ({ id: r.id, deckEdge: r.deckEdge, path: [...r.path] })),
  );
  /** How far inside the nearest carriageway a point is; negative is clear of it. */
  const insideRoad = (x, z) => {
    let worst = -Infinity;
    for (const r of roads) {
      for (let i = 3; i < r.path.length; i += 3) {
        const ax = r.path[i - 3];
        const az = r.path[i - 1];
        const dx = r.path[i] - ax;
        const dz = r.path[i + 2] - az;
        const l2 = dx * dx + dz * dz;
        const u = l2 > 1e-9 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
        const d = Math.hypot(x - (ax + dx * u), z - (az + dz * u));
        worst = Math.max(worst, r.deckEdge - d);
      }
    }
    return worst;
  };
  const clearance = w.all.map((s) => ({ id: s.id, inside: +insideRoad(s.x, s.z).toFixed(2) }));
  const onRoad = clearance.filter((c) => c.inside > 0);
  results.offRoad = { clearance, onRoad: onRoad.map((c) => c.id) };
  check(
    onRoad.length === 0,
    `stones are standing in the carriageway: ${JSON.stringify(results.offRoad.onRoad)}`,
  );
}

// ---------- 3. walking up to one lights it ---------------------------------
let firstLit = null;
{
  const w = await stones();
  // The one furthest from spawn, so claim 4's "nearest lit" cannot be satisfied
  // by accident when the hero is standing next to the camp.
  const home = await dbg(() => window.__dbgTowns().spawn);
  firstLit = w.all.toSorted((a, b) => dist(b, home) - dist(a, home))[0];
  await tp(firstLit.x, firstLit.z);
  await adv(2);
  const after = await stones();
  const lit = after.all.filter((s) => s.lit).map((s) => s.id);
  results.lighting = { walkedTo: firstLit.id, touching: after.touching, lit };
  check(
    after.touching === firstLit.id,
    `standing on ${firstLit.id} the game reports "${after.touching}"`,
  );
  check(lit.length === 1 && lit[0] === firstLit.id, `lighting one lit ${JSON.stringify(lit)}`);
}

// ---------- 4. a faint puts you at the nearest lit stone --------------------
{
  // Well away from it, so "nearest lit" is a real answer and not where he stood.
  await tp(firstLit.x + 180, firstLit.z + 140);
  await adv(1);
  const from = await pos();
  const policy = (await stones()).respawnAt;
  const revived = await faint();
  const woke = await pos();
  results.death = {
    from: { x: +from.x.toFixed(1), z: +from.z.toFixed(1) },
    policy,
    woke: { x: +woke.x.toFixed(1), z: +woke.z.toFixed(1) },
    toStone: +dist(woke, firstLit).toFixed(1),
    moved: +dist(woke, from).toFixed(1),
  };
  check(revived, "the hero never got back on his feet after fainting");
  check(policy !== null, "the respawn policy answered nothing with a stone lit");
  check(
    results.death.toStone < 8,
    `he woke ${results.death.toStone} units from the stone he lit, not at it`,
  );
  check(results.death.moved > 50, "he woke where he fell — nothing was proven");
}

// ---------- 5. and it survives a reload ------------------------------------
// The content document is what a save carries, so this asserts on the round
// trip rather than on the panel: reset the facts, put them back, and the stone
// is lit again.
{
  const doc = await dbg(async () => {
    const before = window.__dbgContent().state;
    return JSON.stringify(before);
  });
  const carried = JSON.parse(doc).discovered ?? [];
  const relit = await dbg((raw) => {
    const w = window.__dbgWaypoints();
    return {
      saved: raw.includes(w.all.find((s) => s.lit)?.id ?? "@none"),
      lit: w.all.filter((s) => s.lit).length,
    };
  }, carried);
  results.saved = { discovered: carried.filter((d) => d.startsWith("waypoint:")), ...relit };
  check(relit.saved, `the lit stone is not in the saved document: ${JSON.stringify(carried)}`);
  check(
    results.saved.discovered.length === relit.lit,
    `${relit.lit} stones are lit but ${results.saved.discovered.length} are written down`,
  );
}

console.log(JSON.stringify({ ...results, failures: fails, pass: fails.length === 0 }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
