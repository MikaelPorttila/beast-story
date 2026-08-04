// Verifies the mob-spawn safe zones (src/world/safe-zones.ts): the wild
// population never APPEARS in a settlement or in a point of interest that asked
// for a keep-out — and is still free to chase the player into one.
//
// Usage: bun tools/test-safezone.mjs      (dev server must be up)
//
// THE RUN IS A PAIR, and neither half means anything alone. "No enemy was ever
// seen inside the Encampment" is equally true of a working keep-out and of a
// world where nothing spawned at all, or where the hero was parked somewhere the
// spawner never reached; "an enemy walked into the Encampment" is equally true
// of a chase and of a keep-out that does nothing. So the same hero, in the same
// world, is measured twice: standing OUTSIDE the disc, where the count inside it
// must be 0 while the count outside it climbs, and then standing IN THE MIDDLE
// of it, where something has to follow him in.
//
// WHY THE FIRST HALF PARKS THE HERO 40 UNITS OUT. A candidate lands 25-60 from
// the player (SPAWN_RING_MIN/MAX in src/combat/index.ts), so at 40 from the town
// centre the ring sweeps straight across the settlement and a broken keep-out
// has every chance to be caught — while the hero himself is far enough outside
// that anything which aggroes him is walking AWAY from the town rather than
// through it. That is what makes a sighting inside the disc during the first
// half unambiguous: nothing that spawned legally has a reason to be there.
//
// It also covers the OTHER half of the rule, which is not the spawner at all: an
// animal that appeared just outside the disc wanders 2-8 units around where it
// started (`pickWanderGoal`, src/combat/enemies.ts) and would amble in on its
// own. Sampling positions rather than spawn events is deliberate for exactly
// that reason — the assertion is about where enemies ARE, not about one call.
//
// Exits non-zero on failure.
import { launchBrowser, newPage, wait } from './browser.mjs';
import { BASE as HOST } from './target.mjs';

const URL = `${HOST}/?menu=0&fs=0&fps=30`;
const browser = await launchBrowser();
const page = await newPage(browser, { width: 1280, height: 800 });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));

await page.goto(URL, { waitUntil: 'load' });
await page.waitForSelector('canvas');
await wait(5000);
await page.focus('canvas').catch(() => {});

const zones = () => page.evaluate(() => window.__dbgSafeZones?.());
const blocks = (x, z) => page.evaluate((a, b) => window.__dbgSafeZones?.(a, b).blocks, x, z);
const enemies = async () => (await page.evaluate(() => window.__dbgBodies?.())).enemies;
const tp = async (x, z) => { await page.evaluate((a, b) => window.__dbgTp(a, b), x, z); };

const results = {};
const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); };

const census = await zones();
if (!census) {
  console.error('__dbgSafeZones is not there — nothing below can run');
  await browser.close();
  process.exit(1);
}

// ---------- 1. the census: who claimed a disc, and how wide ----------
{
  const byId = new Map(census.zones.map((z) => [z.id, z]));
  const perTown = census.towns.map((t) => {
    const zone = byId.get(`town:${t.id}`);
    return { id: t.id, outerRadius: t.outerRadius, zone: zone?.radius ?? null };
  });
  results.census = {
    zones: census.zones,
    perTown,
    dens: census.zones.filter((z) => z.id.startsWith('den:')).length,
  };

  check(census.towns.length > 0, 'no towns in this world — the default arm cannot be tested');
  for (const t of perTown) {
    // A TOWN HAS ONE BY DEFAULT: no shipped town authors `noSpawnRadius`, so
    // every one of these is the derived value, `outerRadius` + the margin.
    check(t.zone !== null, `"${t.id}" has no safe zone — a settlement gets one by default`);
    check(t.zone !== null && Math.abs(t.zone - (t.outerRadius + 6)) < 0.01,
      `"${t.id}" zone ${t.zone} is not outerRadius ${t.outerRadius} + the 6-unit margin`);
  }
  // A POINT OF INTEREST DOES NOT, unless a designer said so. The skill dens say
  // nothing (DEN_NO_SPAWN_RADIUS is 0, and a 0 registers no zone at all); the
  // zone gateway asks for 12 in main.ts.
  check(results.census.dens === 0,
    `${results.census.dens} skill dens claimed a zone — the default for a POI is none`);
  const gate = byId.get('landmark:gateway');
  check(!!gate, 'the zone gateway claimed no keep-out — the designer-set POI arm is untested');
  check(!gate || gate.radius === 12, `the gateway's keep-out is ${gate.radius}, expected 12`);
}

// ---------- 2. the query itself, at the rim ----------
const town = census.towns.reduce((a, b) => (a.noSpawnRadius > b.noSpawnRadius ? a : b));
const seat = census.zones.find((z) => z.id === `town:${town.id}`);
{
  const r = seat.radius;
  const at = async (d) => blocks(seat.x + d, seat.z);
  results.rim = {
    town: town.id, x: seat.x, z: seat.z, radius: r,
    centre: await at(0), inside: await at(r - 0.5), outside: await at(r + 0.5),
  };
  check(results.rim.centre === true, 'the middle of a town does not block a spawn');
  check(results.rim.inside === true, `${r - 0.5} from the middle does not block a spawn`);
  check(results.rim.outside === false, `${r + 0.5} from the middle still blocks — the disc is too wide`);
}

/** Every live enemy, with its distance from the town centre. */
async function census2() {
  const list = await enemies();
  return list.filter((e) => !e.isDead).map((e) => ({
    species: e.species, x: e.x, z: e.z,
    d: Math.hypot(e.x - seat.x, e.z - seat.z),
  }));
}

// ---------- 3. the hero outside: nothing may be inside the disc ----------
{
  // 40 units out on the side away from the world's own spawn point, so the ring
  // sweeps the town and the hero is not standing in his own 20-unit start disc.
  const a = Math.atan2(seat.x - 0, seat.z - 0);
  const hx = seat.x + Math.sin(a) * 40;
  const hz = seat.z + Math.cos(a) * 40;
  await tp(hx, hz);
  await wait(2000);

  let worst = Infinity;          // closest any enemy ever came to the middle
  let worstAt = null;
  let seenOutside = 0;           // the control: spawns DID happen near the town
  let samples = 0;
  for (let i = 0; i < 60; i++) {
    await wait(700);
    const live = await census2();
    samples++;
    for (const e of live) {
      if (e.d < worst) { worst = e.d; worstAt = e; }
      if (e.d < seat.radius + 25) seenOutside++;
    }
  }
  results.heroOutside = {
    heroX: +hx.toFixed(2), heroZ: +hz.toFixed(2), fromTown: 40,
    radius: seat.radius, samples,
    closestApproach: Number.isFinite(worst) ? +worst.toFixed(2) : null,
    closestWas: worstAt,
    sightingsNearTown: seenOutside,
  };
  // THE CONTROL FIRST: without it, `closestApproach === null` passes the claim
  // below and says nothing whatever.
  check(seenOutside > 0,
    'no enemy was ever seen within 25 units of the town rim — nothing spawned, so the run is empty');
  check(Number.isFinite(worst) && worst >= seat.radius,
    `an enemy stood ${worst.toFixed(2)} from the middle of ${town.id}, inside its ${seat.radius} keep-out`);
}

// ---------- 4. the hero inside: a hunter follows him in ----------
//
// THE HERO HAS TO BE LED IN, and teleporting him to the middle and waiting is
// exactly what does not work: it was tried, and the closest anything came in 31
// samples was 31.08 — an idle wanderer that had never noticed him. An enemy 40
// units away has no target (aggro is a radius about the animal, `enemy:` content
// in core.json), so the hero must be walked up to one to acquire it and then
// walked into the town in hops short enough to stay inside the leash. What that
// leaves is a genuine chase, which is the thing being asserted.
{
  const start = (await census2()).sort((a, b) => a.d - b.d)[0] ?? null;
  let best = Infinity;
  let arrived = null;
  const hops = [];
  if (start) {
    // Stand beside it and let `retarget` run (it ticks every 0.22 s).
    await tp(start.x + 2.5, start.z);
    await wait(1500);
    // Then walk the hero to the middle, 4 units at a time. Short hops on
    // purpose: a hero who jumps the whole way spends the leash in one step and
    // the animal gives up rather than following.
    const steps = Math.ceil(start.d / 4);
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      await tp(start.x + (seat.x - start.x) * k, start.z + (seat.z - start.z) * k);
      await wait(1400);
      for (const e of await census2()) {
        if (e.d < best) { best = e.d; arrived = e; }
      }
      hops.push(+best.toFixed(2));
      if (best < seat.radius * 0.8) break;
    }
    // ...and hold in the middle, for whatever is still on its way.
    for (let i = 0; i < 20 && best >= seat.radius * 0.8; i++) {
      await tp(seat.x, seat.z);
      await wait(700);
      for (const e of await census2()) {
        if (e.d < best) { best = e.d; arrived = e; }
      }
    }
  }
  results.heroInside = {
    radius: seat.radius,
    led: start,
    closestPerHop: hops,
    closestApproach: Number.isFinite(best) ? +best.toFixed(2) : null,
    closestWas: arrived,
  };
  check(!!start, 'no live enemy to lead in — section 3 left nothing standing');
  // THE OTHER HALF OF THE PAIR. A zone is a spawn rule, not a wall: something
  // hunting the player has to be able to walk over it. If this ever fails
  // legitimately the fix is in the AI, not in the zone.
  check(Number.isFinite(best) && best < seat.radius,
    `nothing followed the hero into ${town.id} (closest ${best.toFixed(2)} of ${seat.radius}) — `
    + 'a safe zone must not be a wall');
}

console.log(JSON.stringify({ ...results, fails }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
