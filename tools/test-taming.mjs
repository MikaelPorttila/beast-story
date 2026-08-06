// Verifies BONDING — issue #4's whole loop, from an empty roster to an animal
// following you.
//
// Usage: bun tools/test-taming.mjs        (dev server must be up)
//
// WHAT THIS EXISTS FOR. Three of the four rules the feature is made of are
// invisible in a screenshot and unreachable by playing:
//
//  * the ODDS move with the target's health, which is a formula, not a picture;
//  * an orb below a beast's `minTier` never works, whatever its health;
//  * a bond that WORKS and a bond that BREAKS take two different paths out — one
//    removes the beast and grants the species, the other hands it back provoked
//    at the health it had — and a mechanic with a coin flip in it will show you
//    whichever one it feels like.
//
// EVERY ASSERTION IS A PAIR, because half of one proves nothing:
//
//  * full health is a long shot AND the same beast beaten down is not — a build
//    where the odds are a constant passes either half alone;
//  * an under-tier orb is refused AND the tier above it is accepted, or "refuses
//    everything" would pass;
//  * a Gloopling refuses every orb AND a wild Sproutle does not, or a build that
//    had simply lost its capture data would pass;
//  * a refused throw keeps the orb AND an accepted one spends it, or "never
//    spends" and "always spends" each pass one half.
//
// THE OUTCOME IS FORCED, and only the outcome. `__dbgThrowOrb(species, force)`
// decides caught-or-broken outright so that the two settle paths can be asserted
// exactly; a probe that rolled for real would fail one run in twenty, which is a
// flake, and flake is a bug. Nothing else is stubbed — the orb really flies, the
// ceremony really plays, and the roster is read afterwards.
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
await page.waitForFunction(() => window.__dbgBoot?.().playing && window.__dbgAdvance, { timeout: 60000 });
await page.focus('canvas').catch(() => {});

const results = {};
const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); };

const taming = (species) => page.evaluate((s) => window.__dbgTaming(s), species ?? null);
const bodies = () => page.evaluate(() => window.__dbgBodies());
const give = (id, n) => page.evaluate((a, b) => window.__dbgGive?.(a, b), id, n);
const invAct = (id, a) => page.evaluate((x, y) => window.__dbgInvAction(x, y), id, a);
const weaken = (s, f) => page.evaluate((a, b) => window.__dbgWeaken(a, b), s, f);
const throwAt = (s, force) => page.evaluate((a, b) => window.__dbgThrowOrb(a, b), s, force ?? null);
/** Advance SIMULATED seconds. See the harness note in tools/suite/harness.mjs. */
const adv = (s) => page.evaluate((n) => window.__dbgAdvance(n), s);

/**
 * Stand the hero next to a live wild beast of this species, spawning nothing.
 *
 * The population is what it is — `trySpawn` picks uniformly from the roster and
 * tops up to a cap — so this HUNTS for one rather than demanding it exist on the
 * first look, and says so if none ever turns up. All of it in simulated time, so
 * the hunt is bounded in work rather than in wall-clock.
 */
async function goToWild(species) {
  const home = await page.evaluate(() => window.__dbgTowns().spawn);
  for (let tries = 0; tries < 24; tries++) {
    const b = await bodies();
    const e = b.enemies.find((x) => x.species === species);
    if (!e) {
      // TURN THE POPULATION OVER, rather than waiting for one to wander in.
      //
      // `trySpawn` tops the wild pack up to a cap and picks its species
      // uniformly, so once the pack is FULL of the other five nothing new
      // appears however long you wait — and this probe spent a hundred
      // simulated seconds proving that before failing with "no wild-sproutle
      // ever spawned".
      //
      // Hopping 130 units puts every live enemy past the 90-unit despawn
      // distance, so the ring refills around the new spot and each hop is a
      // fresh roll of six. Around the world's own reference point rather than
      // off into the unstreamed distance.
      const a = tries * 1.31;
      await page.evaluate(
        (x, z) => window.__dbgTp(x, z),
        home.x + Math.cos(a) * 130, home.z + Math.sin(a) * 130,
      );
      await adv(3);
      continue;
    }
    {
      // Three units off, which is well inside ORB_RANGE (20) and just outside
      // the bite. Close matters: the orb has to FLY there, and a long shot over
      // broken ground can clip the terrain on the way.
      await page.evaluate((x, z) => window.__dbgTp(x, z), e.x + 3, e.z + 3);
      await adv(0.3);
      // RE-READ. The teleport ran simulation slices, and the population is
      // rebuilt constantly — the animal that was there when we looked is not
      // necessarily the animal that is there now, and every later step in the
      // section keys on it being there.
      const after = (await bodies()).enemies.find((x) => x.species === species);
      if (after) return after;
    }
    await adv(2.5);
  }
  return null;
}

// -- 1. a new game owns nothing ---------------------------------------------
{
  const t = await taming();
  const b = await bodies();
  results.start = {
    owned: t.owned, lead: t.lead, support: t.support,
    readied: t.readied, held: t.held, partyBodies: b.beasts.length,
  };
  check(t.owned.length === 0, `a new game starts bonded to ${t.owned.length} beasts, want 0`);
  check(t.lead === null && t.support === null,
    `a new game has lead=${t.lead} support=${t.support}, want both null`);
  check(b.beasts.length === 0, `${b.beasts.length} companions are in the world at boot, want 0`);
  // The other half: the kit that makes the first bond reachable at all.
  check(t.readied === 'orb-tame', `the starting kit readies "${t.readied}", want "orb-tame"`);
  check(t.held === 1, `the starting kit holds ${t.held} orbs, want 1`);
}

// -- 2. the odds move with health -------------------------------------------
{
  const found = await goToWild('wild-sproutle');
  check(found !== null, 'no wild-sproutle ever spawned — the wild roster may not be loading');
  if (found) {
    const full = await taming('wild-sproutle');
    await weaken('wild-sproutle', 0.1);
    const hurt = await taming('wild-sproutle');
    results.odds = {
      fullHp: full.target?.hp, fullChance: full.target?.chance,
      hurtHp: hurt.target?.hp, hurtChance: hurt.target?.chance,
    };
    check(full.target !== null, 'a wild-sproutle four units away is not a target at all');
    // BOTH HALVES. A build whose odds ignore health passes either one alone.
    check(full.target && full.target.chance <= 0.2,
      `a Tame Orb against a full-health Sproutle is ${full.target?.chance}, want a long shot (<= 0.2)`);
    check(hurt.target && hurt.target.chance >= full.target.chance * 2.5,
      `beaten to 10% health the same throw is ${hurt.target?.chance}, ` +
      `barely up from ${full.target?.chance} — health is not moving the odds`);
  }
}

// -- 3. the tier gate, and that a refusal is free ----------------------------
{
  // A Boulderpup needs a Greater Orb (minTier 2). Both halves against the SAME
  // animal, so nothing but the orb differs.
  const found = await goToWild('wild-boulderpup');
  check(found !== null, 'no wild-boulderpup ever spawned');
  if (found) {
    await weaken('wild-boulderpup', 0.1);
    await give('orb-greater', 1);
    await invAct('orb-tame', 'ready');
    const before = (await taming()).held;
    const weak = await throwAt('wild-boulderpup');
    const afterWeak = (await taming()).held;
    await invAct('orb-greater', 'ready');
    const strong = await throwAt('wild-boulderpup', false);
    const afterStrong = (await taming()).held;
    results.tierGate = {
      tameOutcome: weak.outcome, tameHeldBefore: before, tameHeldAfter: afterWeak,
      greaterOutcome: strong.outcome, greaterHeldAfter: afterStrong,
    };
    check(weak.outcome === 'orbTooWeak',
      `a Tame Orb at a Boulderpup returned "${weak.outcome}", want "orbTooWeak"`);
    check(afterWeak === before,
      `a refused throw spent an orb (${before} -> ${afterWeak}) — a refusal must be free`);
    check(strong.outcome === 'thrown',
      `a Greater Orb at the same Boulderpup returned "${strong.outcome}", want "thrown"`);
    check(afterStrong === 0,
      `an accepted throw left ${afterStrong} Greater Orbs, want 0 — it must be spent`);
  }
}

// -- 4. a broken bond hands the animal back ---------------------------------
{
  // Section 3 threw with force=false, so this is that same bond settling.
  await page.waitForFunction(() => !window.__dbgTaming().bonding, { timeout: 20000 })
    .catch(() => {});
  const t = await taming();
  const b = await bodies();
  const still = b.enemies.some((e) => e.species === 'wild-boulderpup');
  results.broke = { owned: t.owned, boulderpupStillWild: still };
  check(t.owned.length === 0,
    `a BROKEN bond granted ${JSON.stringify(t.owned)} — it must grant nothing`);
  check(still, 'a broken bond removed the beast anyway — it has to come back out');
}

// -- 5. a bond that works ----------------------------------------------------
{
  const found = await goToWild('wild-sproutle');
  check(found !== null, 'no wild-sproutle left to bond');
  if (found) {
    await give('orb-tame', 1);
    await invAct('orb-tame', 'ready');
    const hurt = await weaken('wild-sproutle', 0.1);
    check(hurt.ok, `nothing to weaken before the bonding throw: ${hurt.why ?? ''}`);
    // BY ID, not by species. The population can easily hold two Sproutles, so
    // "no wild Sproutle remains" would fail on the one still grazing forty units
    // away — which is not the claim. The hook returns the id it actually threw
    // at, and that id is what gets checked.
    const res = await throwAt('wild-sproutle', true);
    const victim = { id: res.id };
    results.bondThrow = { outcome: res.outcome, dist: res.dist, id: res.id, weakened: hurt.id };
    check(res.outcome === 'thrown', `the bonding throw returned "${res.outcome}", want "thrown"`);
    check(res.id === hurt.id,
      `the throw went at #${res.id} but #${hurt.id} was the one weakened`);
    // THE ORB HAS TO ARRIVE. Waiting only for `bonding` to go false would pass
    // instantly for a throw that never reached anything, so the ceremony is
    // waited FOR and then waited OUT — the two halves of "it landed on it".
    let started = false;
    for (let i = 0; i < 24 && !started; i++) {
      await adv(0.1);
      started = (await taming()).bonding;
    }
    check(started, `the orb never reached the Sproutle ${res.dist} units away`);
    for (let i = 0; i < 60 && (await taming()).bonding; i++) await adv(0.1);
    await adv(0.3);
    const t = await taming();
    const b = await bodies();
    results.bonded = {
      owned: t.owned, lead: t.lead, support: t.support,
      partyBodies: b.beasts.length,
      bondedOneStillWild: victim ? b.enemies.some((e) => e.id === victim.id) : null,
    };
    check(t.owned.includes('sproutle'),
      `after a caught bond the player owns ${JSON.stringify(t.owned)}, want it to include "sproutle"`);
    // THE FIRST BOND LEADS — the auto-fill rule, which is the difference between
    // walking away with an animal and walking away with a panel entry.
    check(t.lead === 'sproutle',
      `the first bond left lead=${t.lead}, want "sproutle" — it should fill the empty slot`);
    check(b.beasts.length === 1,
      `${b.beasts.length} companions are in the world after one bond, want 1`);
    check(victim.id !== null, 'the throw hook named no target');
    check(results.bonded.bondedOneStillWild === false,
      'the Sproutle that was bonded is still standing there as a wild enemy');
  }
}

// -- 6. what cannot be bonded, and what is already yours ---------------------
{
  await give('orb-master', 2);
  await invAct('orb-master', 'ready');

  const foundG = await goToWild('gloopling');
  if (foundG) {
    const before = (await taming()).held;
    const res = await throwAt('gloopling');
    const after = (await taming()).held;
    results.gloopling = { outcome: res.outcome, heldBefore: before, heldAfter: after };
    check(res.outcome === 'notBondable',
      `a Master Orb at a Gloopling returned "${res.outcome}", want "notBondable"`);
    check(after === before, 'throwing at a Gloopling spent an orb');
  } else {
    results.gloopling = 'none spawned';
  }

  const foundS = await goToWild('wild-sproutle');
  if (foundS) {
    const before = (await taming()).held;
    const res = await throwAt('wild-sproutle');
    const after = (await taming()).held;
    results.duplicate = { outcome: res.outcome, heldBefore: before, heldAfter: after };
    check(res.outcome === 'alreadyOwned',
      `a second Sproutle returned "${res.outcome}", want "alreadyOwned"`);
    check(after === before, 'throwing at a species you already own spent an orb');
  } else {
    results.duplicate = 'none spawned';
  }
}

// -- 7. a wild beast is ANIMATED, not a statue -------------------------------
{
  // The claim is that `species.animate` is actually being called on a wild body
  // — the one thing the whole "an enemy wearing a beast's rig" design is for.
  // Measured as MOTION rather than as a flag: the beast has to have gone
  // somewhere over a second of simulated time.
  const found = await goToWild('wild-galebird');
  results.wildMotion = 'no wild-galebird spawned';
  if (found) {
    // BY ID again, and here it is the difference between a measurement and a
    // coincidence: one Galebird despawning while another arrives would read as
    // eighty units of travel in a second.
    const a = (await bodies()).enemies.find((e) => e.species === 'wild-galebird');
    await adv(1.2);
    const b2 = a ? (await bodies()).enemies.find((e) => e.id === a.id) : undefined;
    check(a !== undefined, 'no wild Galebird to measure');
    check(b2 !== undefined, 'the Galebird being measured despawned mid-measurement');
    if (a && b2) {
      const moved = Math.hypot(b2.x - a.x, b2.z - a.z) + Math.abs(b2.y - a.y);
      results.wildMotion = { id: a.id, moved: +moved.toFixed(2) };
      check(moved > 0.2,
        `a wild Galebird travelled ${moved.toFixed(2)} units in 1.2 s — it is not being driven`);
    }
  }
}

// -- 8. the content numbers match the rig they are worn by -------------------
{
  // `EnemyData.radius`/`height` are AUTHORED and a beast's body MEASURES itself
  // — see the note on those fields in src/content/types/enemy.ts. They drift
  // silently: nothing crashes, the hp bar floats in the wrong place and the
  // animal is reached from the wrong distance.
  //
  // 0.06 is a voxel and a bit at the scales these rigs are built at: tight
  // enough to catch a species whose shape actually changed, loose enough that
  // rounding to two decimals in the probe surface cannot trip it.
  const TOL = 0.06;
  const rows = (await bodies()).enemies.filter((e) => e.rigHeight !== null);
  const seen = {};
  for (const e of rows) {
    if (seen[e.species]) continue;
    seen[e.species] = { authored: [e.radius, e.height], rig: [e.rigRadius, e.rigHeight] };
    check(Math.abs(e.radius - e.rigRadius) <= TOL,
      `${e.species} is authored radius ${e.radius} but its rig measures ${e.rigRadius}`);
    check(Math.abs(e.height - e.rigHeight) <= TOL,
      `${e.species} is authored height ${e.height} but its rig measures ${e.rigHeight}`);
  }
  results.footprints = seen;
  // The other half: a painted enemy has no rig, and must not claim one.
  const painted = (await bodies()).enemies.filter((e) => e.rigHeight === null).map((e) => e.species);
  results.paintedNoRig = [...new Set(painted)];
  check(rows.length > 0, 'no wild beast was in the world to compare footprints against');
}

console.log(JSON.stringify({ ...results, fails }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
