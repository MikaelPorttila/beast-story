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
import { launchBrowser, newPage } from "./browser.mjs";
import { BASE as HOST } from "./target.mjs";

const URL = `${HOST}/?menu=0&fs=0`;
const browser = await launchBrowser();
const page = await newPage(browser, { width: 1280, height: 800 });
page.on("pageerror", (e) => console.error("[pageerror]", e.message));

await page.goto(URL, { waitUntil: "load" });
await page.waitForSelector("canvas");
await page.waitForFunction(() => window.__dbgBoot?.().playing && window.__dbgAdvance, {
  timeout: 60000,
});
await page.focus("canvas").catch(() => {});

const results = {};
const fails = [];
const check = (ok, msg) => {
  if (!ok) {
    fails.push(msg);
  }
};

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
        home.x + Math.cos(a) * 130,
        home.z + Math.sin(a) * 130,
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
      if (after) {
        return after;
      }
    }
    await adv(2.5);
  }
  return null;
}

// -- 1. a PLAYER's new game owns nothing --------------------------------------
//
// Issue #4, back in force: this page boots without `debug=1`, so it is the game a
// player gets, and that game bonds nobody — the starter is the developer's
// (`STARTER_BEAST` in main.ts, under the flag). Both slots empty is what everything
// below leans on, because the auto-fill rule this file is about is "a new bond
// takes the empty slot".
{
  const t = await taming();
  const b = await bodies();
  results.start = {
    owned: t.owned,
    lead: t.lead,
    support: t.support,
    readied: t.readied,
    held: t.held,
    partyBodies: b.beasts.length,
  };
  check(
    t.owned.length === 0,
    `a player's new game starts bonded to ${JSON.stringify(t.owned)}, want nobody (issue #4)`,
  );
  check(
    t.lead === null && t.support === null,
    `a player's new game has lead=${t.lead} support=${t.support}, want both empty`,
  );
  check(b.beasts.length === 0, `${b.beasts.length} companions are in the world at boot, want 0`);
  // The other half: the kit that makes the first bond reachable at all.
  check(t.readied === "orb-tame", `the starting kit readies "${t.readied}", want "orb-tame"`);
  check(t.held === 1, `the starting kit holds ${t.held} orbs, want 1`);
}

// -- 1b. and then it owns nothing --------------------------------------------
//
// EVERY SECTION BELOW STAGES A WILD ANIMAL BESIDE THE HERO, and a companion
// standing beside him fights it. Measured, when a new game still bonded the
// starter: this file failed about two runs in five — the staged Boulderpup gone
// from the assist sweep entirely on one run, the meadow down from four Sproutles
// to two on another. A player's boot is empty now; the release stays as the
// guarantee, AFTER the section above has asserted the boot. What is under test
// here is EARNING a bond; who walks beside the player while it is earned is
// test-companion's subject, not this one.
{
  const said = await page.evaluate(() => window.__dbgGrantBeast("none"));
  const t = await taming();
  results.cleared = { said, owned: t.owned, lead: t.lead, support: t.support };
  check(
    t.owned.length === 0 && t.lead === null,
    `releasing every bond left ${JSON.stringify(t.owned)} lead=${t.lead} — the sections ` +
      "below all assume an empty party",
  );
}

// -- 2. the odds move with health -------------------------------------------
{
  const found = await goToWild("wild-sproutle");
  check(found !== null, "no wild-sproutle ever spawned — the wild roster may not be loading");
  if (found) {
    const full = await taming("wild-sproutle");
    await weaken("wild-sproutle", 0.1);
    const hurt = await taming("wild-sproutle");
    results.odds = {
      fullHp: full.target?.hp,
      fullChance: full.target?.chance,
      hurtHp: hurt.target?.hp,
      hurtChance: hurt.target?.chance,
    };
    check(full.target !== null, "a wild-sproutle four units away is not a target at all");
    // BOTH HALVES. A build whose odds ignore health passes either one alone.
    check(
      full.target && full.target.chance <= 0.2,
      `a Tame Orb against a full-health Sproutle is ${full.target?.chance}, want a long shot (<= 0.2)`,
    );
    check(
      hurt.target && hurt.target.chance >= full.target.chance * 2.5,
      `beaten to 10% health the same throw is ${hurt.target?.chance}, ` +
        `barely up from ${full.target?.chance} — health is not moving the odds`,
    );
  }
}

// -- 3. EVERY ORB MAY BE THROWN AT EVERYTHING, and the tier moves the odds ---
//
// This section used to assert the opposite: a Tame Orb at a Boulderpup was
// REFUSED as too weak, and the refusal was free. Issue #110 removed that gate —
// "the player may use any Taming orb, but the % chance will differ, so no text
// saying that it's not possible" — so the pair here is now the other way round.
// Both throws are accepted and both are spent; what separates them is the
// number the player is shown before they commit.
{
  // Both halves against the SAME animal at the same health, so nothing but the
  // orb differs.

  const found = await goToWild("wild-boulderpup");
  check(found !== null, "no wild-boulderpup ever spawned");
  if (found) {
    await weaken("wild-boulderpup", 0.1);
    await give("orb-greater", 1);
    await invAct("orb-tame", "ready");
    // BOTH ODDS FIRST, on the same animal at the same health and before either
    // orb leaves the hand. Reading one after a throw compares two different
    // animals — the first attempt at this caught the Boulderpup with the Tame
    // Orb (0.28 at a tenth of its health, which is the mechanic working) and
    // then read the "Greater" number off a fresh full-health one, making a
    // better orb look worse.
    const tameChance = (await taming("wild-boulderpup")).target?.chance ?? null;
    await invAct("orb-greater", "ready");
    const greaterChance = (await taming("wild-boulderpup")).target?.chance ?? null;

    // Now the throws, both BROKEN on purpose (force=false) so neither outcome
    // depends on a roll and neither takes the animal the other one needs.
    await invAct("orb-tame", "ready");
    const before = (await taming()).held;
    const weak = await throwAt("wild-boulderpup", false);
    const afterWeak = (await taming()).held;
    // WAIT FOR THE CEREMONY, THEN WAIT IT OUT — the file's own two-halves rule.
    // Waiting only for `bonding` to be false passed DURING the first orb's
    // flight, and the second throw then found the Boulderpup held: "noTarget".
    // Issue #198's fix surfaced this — before it, the first orb fizzled often
    // enough that the race read as a pass.
    for (let k = 0; k < 24 && !(await taming()).bonding; k++) {
      await adv(0.1);
    }
    for (let k = 0; k < 60 && (await taming()).bonding; k++) {
      await adv(0.1);
    }
    await invAct("orb-greater", "ready");
    const strong = await throwAt("wild-boulderpup", false);
    const afterStrong = (await taming()).held;
    results.tierGate = {
      tameOutcome: weak.outcome,
      tameHeldBefore: before,
      tameHeldAfter: afterWeak,
      greaterOutcome: strong.outcome,
      greaterHeldAfter: afterStrong,
      tameChance,
      greaterChance,
    };
    check(
      weak.outcome === "thrown",
      `a Tame Orb at a Boulderpup returned "${weak.outcome}", want "thrown" — ` +
        "no orb is refused for being weak any more (issue #110)",
    );
    check(
      afterWeak === before - 1,
      `an accepted throw left the Tame Orbs at ${afterWeak} from ${before} — it must be spent`,
    );
    check(
      strong.outcome === "thrown",
      `a Greater Orb at the same Boulderpup returned "${strong.outcome}", want "thrown"`,
    );
    check(
      afterStrong === 0,
      `an accepted throw left ${afterStrong} Greater Orbs, want 0 — it must be spent`,
    );
    // THE ODDS ARE THE DIFFERENCE, which is the half that says the tiers still
    // mean something now that neither is refused.
    check(
      results.tierGate.tameChance !== null && results.tierGate.greaterChance !== null,
      "no capture chance was reported for one of the two orbs",
    );
    check(
      (results.tierGate.greaterChance ?? 0) > (results.tierGate.tameChance ?? 1),
      `a Greater Orb reads ${results.tierGate.greaterChance} against a Tame Orb's ` +
        `${results.tierGate.tameChance} on the same animal — a better orb has to be better`,
    );
  }
}

// -- 4. a broken bond hands the animal back ---------------------------------
{
  // Section 3 threw with force=false, so this is that same bond settling.
  await page
    .waitForFunction(() => !window.__dbgTaming().bonding, { timeout: 20000 })
    .catch(() => {});
  const t = await taming();
  const b = await bodies();
  const still = b.enemies.some((e) => e.species === "wild-boulderpup");
  results.broke = { owned: t.owned, boulderpupStillWild: still };
  check(
    t.owned.length === 0,
    `a BROKEN bond granted ${JSON.stringify(t.owned)} — it must grant nothing`,
  );
  check(still, "a broken bond removed the beast anyway — it has to come back out");
}

// -- 4b. EVERY throw arrives, against a target that is MOVING (issue #198) ----
//
// A hurt wild animal walks, and the homing lerp's ~5-unit turn radius let a
// side-step turn one throw in three into a silent ground fizzle — accepted
// throw, then no bond and no bondFailed, ever. Section 5's staging retries are
// right for its claim and would hide this one; here ARRIVAL ITSELF is the
// claim, so every accepted throw must start a ceremony. Forced to FALSE so the
// beast escapes and stays on the board for the next throw.
{
  const found = await goToWild("wild-sproutle");
  check(found !== null, "no wild-sproutle for the arrival section");
  if (found) {
    const THROWS = 6;
    await give("orb-tame", THROWS);
    await invAct("orb-tame", "ready");
    const hurt = await weaken("wild-sproutle", 0.1);
    check(hurt.ok, `nothing to weaken for the arrival section: ${hurt.why ?? ""}`);
    let arrived = 0;
    let thrown = 0;
    const throws = [];
    for (let i = 0; i < THROWS; i++) {
      // Wait out the previous ceremony — `busy` refuses a second orb at a held
      // beast, and that refusal is section 6's subject, not a miss.
      for (let k = 0; k < 40 && (await taming()).bonding; k++) {
        await adv(0.25);
      }
      const res = await throwAt("wild-sproutle", false);
      if (res.outcome !== "thrown") {
        // The beast wandered out of throw range or another animal took the
        // lock — staging, not arrival. Re-stage and spend the attempt.
        await goToWild("wild-sproutle");
        await weaken("wild-sproutle", 0.1);
        throws.push({ outcome: res.outcome, dist: res.dist });
        continue;
      }
      thrown++;
      let started = false;
      for (let k = 0; k < 12 && !started; k++) {
        await adv(0.25);
        started = (await taming()).bonding;
      }
      throws.push({ outcome: res.outcome, dist: res.dist, arrived: started });
      if (started) {
        arrived++;
      }
    }
    results.movingArrival = { thrown, arrived, throws };
    check(thrown >= 3, `only ${thrown} of ${THROWS} throws were even accepted — staging is broken`);
    check(
      arrived === thrown,
      `${arrived}/${thrown} accepted throws arrived — every one must (issue #198): ` +
        JSON.stringify(throws),
    );
    // Drain the LAST ceremony before handing over: section 5 stages against a
    // live, unheld animal, and a bond still playing here is one it would read.
    for (let k = 0; k < 40 && (await taming()).bonding; k++) {
      await adv(0.25);
    }
    // Six escapes leave a provoked pack crowding the hero, and a crowd is what
    // turns section 5's throw into an interception (a snapclaw took the orb and
    // got owned in its place). The same reset `goToWild` uses: hop past the
    // 90-unit despawn ring, so section 5 hunts a fresh, calm population.
    const home = await page.evaluate(() => window.__dbgTowns().spawn);
    await page.evaluate((x, z) => window.__dbgTp(x, z), home.x + 130, home.z - 130);
    await adv(3);
  }
}

// -- 5. a bond that works ----------------------------------------------------
{
  const found = await goToWild("wild-sproutle");
  check(found !== null, "no wild-sproutle left to bond");
  if (found) {
    // FOUR ORBS, because the STAGING is allowed to fail and the claim is not.
    //
    // A throw can legitimately come to nothing: the orb flies, and over broken
    // ground it can clip the terrain, or a Gloopling can walk into the line and
    // take it (which is the behaviour a thrown object should have — see the
    // aim-assist note in main.ts). Neither says anything about bonding. So the
    // placement, the weakening and the throw are retried together until an orb
    // actually ARRIVES, and only then does the section start asserting. The
    // assertions themselves are untouched and the outcome is still forced.
    await give("orb-tame", 4);
    await invAct("orb-tame", "ready");
    let hurt = { ok: false, why: "never staged" };
    let res = { outcome: "never thrown", id: null, dist: null };
    let wildBefore = 0;
    let started = false;
    for (let attempt = 0; attempt < 3 && !started; attempt++) {
      if (attempt > 0 && !(await goToWild("wild-sproutle"))) {
        break;
      }
      hurt = await weaken("wild-sproutle", 0.1);
      if (!hurt.ok) {
        continue;
      }
      wildBefore = (await bodies()).enemies.filter((e) => e.species === "wild-sproutle").length;
      res = await throwAt("wild-sproutle", true);
      if (res.outcome !== "thrown") {
        continue;
      }
      // THE ORB HAS TO ARRIVE. Waiting only for `bonding` to go false would
      // pass instantly for a throw that never reached anything, so the ceremony
      // is waited FOR here and waited OUT below — the two halves of "it landed".
      for (let i = 0; i < 24 && !started; i++) {
        await adv(0.1);
        started = (await taming()).bonding;
      }
    }
    const victim = { id: res.id };
    results.bondThrow = { outcome: res.outcome, dist: res.dist, id: res.id, weakened: hurt.id };
    check(hurt.ok, `nothing to weaken before the bonding throw: ${hurt.why ?? ""}`);
    check(res.outcome === "thrown", `the bonding throw returned "${res.outcome}", want "thrown"`);
    check(started, `no orb ever reached a Sproutle in three tries (last ${res.dist} units away)`);
    for (let i = 0; i < 60 && (await taming()).bonding; i++) {
      await adv(0.1);
    }
    await adv(0.3);
    const t = await taming();
    const b = await bodies();
    results.bonded = {
      owned: t.owned,
      lead: t.lead,
      support: t.support,
      partyBodies: b.beasts.length,
      bondedOneStillWild: victim ? b.enemies.some((e) => e.id === victim.id) : null,
      wildSproutlesAfter: b.enemies.filter((e) => e.species === "wild-sproutle").length,
    };
    check(
      t.owned.includes("sproutle"),
      `after a caught bond the player owns ${JSON.stringify(t.owned)}, want it to include "sproutle"`,
    );
    // THE FIRST BOND LEADS — the auto-fill rule, which is the difference between
    // walking away with an animal and walking away with a panel entry.
    // THE FIRST BOND LEADS — the auto-fill rule, which is the difference between
    // walking away with an animal and walking away with a panel entry. Read
    // against the EMPTY party section 1b left behind, so this is still "the
    // first bond takes the empty slot" and the empty slot is still the lead.
    check(
      t.lead === "sproutle",
      `the first bond left lead=${t.lead}, want "sproutle" — it should fill the empty slot`,
    );
    check(
      b.beasts.length === 1,
      `${b.beasts.length} companions are in the world after one bond, want 1`,
    );
    check(victim.id !== null, "the throw hook named no target");
    // ONE FEWER SPROUTLE, not "that exact id is gone". The orb HOMES on the one
    // it was thrown at but lands on whatever it physically reaches first — a
    // second Sproutle that walks into the line takes it instead, which is the
    // behaviour a thrown object should have and is exactly what the aim assist's
    // note in main.ts says. Pinning the id failed on that perfectly correct run.
    // EITHER piece of evidence that one left the board. The orb HOMES on the one
    // it was thrown at but lands on whatever it physically reaches first, so a
    // second Sproutle walking into the line takes it instead — which is the
    // behaviour a thrown object should have (see the aim-assist note in main.ts)
    // and which pinning the id failed on. The count alone is no better: the
    // spawner tops the pack up during the two-second ceremony and can put the
    // number straight back. Together they are solid.
    check(
      !results.bonded.bondedOneStillWild || results.bonded.wildSproutlesAfter < wildBefore,
      `the bonded Sproutle (#${victim.id}) is still wild and the count went ` +
        `${wildBefore} -> ${results.bonded.wildSproutlesAfter} — nothing left the board`,
    );
  }
}

// -- 6. what cannot be bonded, and a second of what is already yours ---------
{
  await give("orb-master", 2);
  await invAct("orb-master", "ready");

  const foundG = await goToWild("gloopling");
  if (foundG) {
    const before = (await taming()).held;
    const res = await throwAt("gloopling");
    const after = (await taming()).held;
    results.gloopling = { outcome: res.outcome, heldBefore: before, heldAfter: after };
    check(
      res.outcome === "notBondable",
      `a Master Orb at a Gloopling returned "${res.outcome}", want "notBondable"`,
    );
    check(after === before, "throwing at a Gloopling spent an orb");
  } else {
    results.gloopling = "none spawned";
  }

  // A SECOND SPROUTLE IS A REAL BOND (issue #110): the throw is accepted and, forced
  // to land, adds a second BODY of the species — its own id, its own level 1 —
  // beside the one section 5 caught, which keeps its slot. Staged like section 5:
  // the arrival is retried, the claim is not.
  const foundS = await goToWild("wild-sproutle");
  if (foundS) {
    const ownedBefore = (await taming()).owned;
    let res = { outcome: "never thrown" };
    let started = false;
    for (let attempt = 0; attempt < 3 && !started; attempt++) {
      if (attempt > 0 && !(await goToWild("wild-sproutle"))) {
        break;
      }
      if (!(await weaken("wild-sproutle", 0.1)).ok) {
        continue;
      }
      res = await throwAt("wild-sproutle", true);
      if (res.outcome !== "thrown") {
        continue;
      }
      for (let i = 0; i < 24 && !started; i++) {
        await adv(0.1);
        started = (await taming()).bonding;
      }
    }
    for (let i = 0; i < 60 && (await taming()).bonding; i++) {
      await adv(0.1);
    }
    await adv(0.3);
    const t = await taming();
    const sproutles = t.owned.filter((id) => id === "sproutle" || id.startsWith("sproutle#"));
    results.duplicate = { outcome: res.outcome, ownedBefore, owned: t.owned, lead: t.lead };
    check(res.outcome === "thrown", `a second Sproutle returned "${res.outcome}", want "thrown"`);
    check(started, "no orb ever reached the second Sproutle in three tries");
    check(
      sproutles.length === 2 && sproutles.includes("sproutle#2"),
      `a second bond left the Sproutles as ${JSON.stringify(sproutles)}, want ["sproutle", "sproutle#2"]`,
    );
    check(t.lead === "sproutle", `the second body took the lead from the first (lead=${t.lead})`);
  } else {
    results.duplicate = "none spawned";
  }
}

// -- 7. a wild beast is ANIMATED, not a statue -------------------------------
{
  // The claim is that `species.animate` is actually being called on a wild body
  // — the one thing the whole "an enemy wearing a beast's rig" design is for.
  // Measured as MOTION rather than as a flag: the beast has to have gone
  // somewhere over a second of simulated time.
  const found = await goToWild("wild-galebird");
  results.wildMotion = "no wild-galebird spawned";
  if (found) {
    // BY ID again, and here it is the difference between a measurement and a
    // coincidence: one Galebird despawning while another arrives would read as
    // eighty units of travel in a second.
    const a = (await bodies()).enemies.find((e) => e.species === "wild-galebird");
    await adv(1.2);
    const b2 = a ? (await bodies()).enemies.find((e) => e.id === a.id) : undefined;
    check(a !== undefined, "no wild Galebird to measure");
    check(b2 !== undefined, "the Galebird being measured despawned mid-measurement");
    if (a && b2) {
      const moved = Math.hypot(b2.x - a.x, b2.z - a.z) + Math.abs(b2.y - a.y);
      results.wildMotion = { id: a.id, moved: +moved.toFixed(2) };
      check(
        moved > 0.2,
        `a wild Galebird travelled ${moved.toFixed(2)} units in 1.2 s — it is not being driven`,
      );
    }
  }
}

// -- 7b. the aim assist is wide, and prefers what it can actually bond -------
{
  // THE FEEDBACK THIS EXISTS FOR: holding a twenty-degree reticle on a moving
  // animal was losing the throw to the aiming rather than to the odds. The
  // assist's cone is ~66 degrees each side now (`ORB_AIM_CONE_COS`), so this
  // asserts BOTH ENDS of it — a bearing the old cone would have dropped still
  // finds the beast, and one well outside the new cone still finds nothing.
  // Without the second half, "always returns a target" would pass.
  // A BOULDERPUP, not the Sproutle. By this point in the run a Sproutle is
  // BONDED, and the assist deliberately outranks a species you already own —
  // so it would keep choosing something else and the sweep would read as a cone
  // that lost its target at two units. (That it does so is the bondable-first
  // rule working; section 6 is where the refusal itself is asserted.) The
  // Boulderpup broke free in section 3 and is still wild, and a Master Orb
  // clears its minTier.
  const found = await goToWild("wild-boulderpup");
  results.assist = found === null ? "no wild-boulderpup to aim at" : null;
  if (found) {
    await give("orb-master", 1);
    await invAct("orb-master", "ready");

    // ONE READ PER SAMPLE. `__dbgOrbAim` reports the off-axis angle AND the
    // assist's choice from the same instant and the same camera vector — see
    // its note in main.ts. Assembling those from separate round-trips let the
    // animal walk between them, which showed up as a beast lost inside the cone
    // about one run in three and was not a cone at all.
    const samples = [];
    for (let deg = -180; deg < 180; deg += 20) {
      // RE-PLACED BEFORE EVERY SAMPLE. Each swing costs a second of simulated
      // time and the animal walks throughout; over eighteen of them it strolls
      // clean out of ORB_RANGE. Six units: well inside the 20 it can be thrown
      // from, and far enough out that it does not simply bite him.
      const before = (await bodies()).enemies.find((e) => e.id === found.id);
      if (!before) {
        continue;
      }
      await page.evaluate((x, z) => window.__dbgTp(x, z), before.x + 6, before.z);
      await page.evaluate((b) => window.__dbgAim(b), (deg * Math.PI) / 180);
      // The swing arrives over a few hundred ms — settle on simulated time, as
      // the note on `__dbgAim` in main.ts says.
      await adv(1.2);
      const a = await page.evaluate((sp) => window.__dbgOrbAim(sp), "wild-boulderpup");
      // ONLY IF THE STAGING TOOK. The hop above puts the hero six units off; a
      // sample that comes back with the animal nineteen units away is one where
      // it wandered off or the teleport landed somewhere it could not stand, and
      // it says nothing about the cone at that bearing. Dropped rather than
      // counted — the usable-sample check below is what stops this quietly
      // turning into a probe that measures nothing.
      if (a && a.dist <= 10) {
        samples.push({ off: a.offDeg, dist: a.dist, hit: a.pickedThis, picked: a.picked });
      }
    }
    results.assist = samples;

    // BOTH ENDS OF THE CONE. `ORB_AIM_CONE_COS` is ~66 degrees each side, so a
    // sample well inside it must find the beast and one well outside must not.
    // Without the second half, "always returns a target" would pass — and that
    // is autoaim, not aiming.
    // 55 and 75 bracket the cone's ~66 degrees with a guard band either side.
    // It can be this tight because `off` and the decision come from the SAME
    // instant (see `__dbgOrbAim`) — there is no drift between them to allow for,
    // only the boundary itself, which no sample should be asked about.
    const inside = samples.filter((s) => s.off <= 55);
    const outside = samples.filter((s) => s.off >= 75);
    check(
      inside.length >= 2 && outside.length >= 2,
      `the sweep landed ${inside.length} samples inside the cone and ${outside.length} outside; ` +
        `it needs at least two of each to mean anything: ${JSON.stringify(samples)}`,
    );

    // WHAT IS ASSERTED, AND WHY IT IS NOT `pickedThis` BOTH WAYS.
    //
    // Inside the cone the claim is that the player is GIVEN something to throw
    // at — `picked`. It cannot be "this exact animal", because the assist
    // deliberately prefers a bondable candidate over a nearer unbondable one and
    // the meadow decides what else is standing about; a Galebird two units away
    // outranking the staged Boulderpup is the rule working, not the cone failing.
    //
    // Outside the cone the claim is the opposite and it CAN be exact: whatever
    // else the assist chooses, it must not choose the animal that is behind him.
    // That is what makes this a pair rather than "it always finds something",
    // which is autoaim and would pass either half alone.
    check(
      inside.every((s) => s.picked),
      `within 55 degrees of a beast the assist offered nothing at ` +
        `${JSON.stringify(inside.filter((s) => !s.picked))} — that is the old weapon cone, ` +
        "and it is the complaint this widening answers",
    );
    check(
      outside.every((s) => !s.hit),
      `past 75 degrees the assist still chose the animal behind him at ` +
        `${JSON.stringify(outside.filter((s) => s.hit))} — that is not aiming`,
    );
    // ...and the staged animal really is reachable, or the half above is a
    // statement about some other beast entirely.
    check(
      inside.some((s) => s.hit),
      `the staged Boulderpup was never chosen at any bearing: ${JSON.stringify(inside)}`,
    );
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
  // MAKE SURE THERE IS ONE. The sections above hop the hero around the map
  // hunting for species, and where he ends up is not guaranteed to have a wild
  // beast in sight — "no wild beast to compare against" is a probe that ran out
  // of world, not a footprint that drifted.
  await goToWild("wild-sproutle");
  const rows = (await bodies()).enemies.filter((e) => e.rigHeight !== null);
  const seen = {};
  for (const e of rows) {
    if (seen[e.species]) {
      continue;
    }
    seen[e.species] = { authored: [e.radius, e.height], rig: [e.rigRadius, e.rigHeight] };
    check(
      Math.abs(e.radius - e.rigRadius) <= TOL,
      `${e.species} is authored radius ${e.radius} but its rig measures ${e.rigRadius}`,
    );
    check(
      Math.abs(e.height - e.rigHeight) <= TOL,
      `${e.species} is authored height ${e.height} but its rig measures ${e.rigHeight}`,
    );
  }
  results.footprints = seen;
  // The other half: a painted enemy has no rig, and must not claim one.
  const painted = (await bodies()).enemies
    .filter((e) => e.rigHeight === null)
    .map((e) => e.species);
  results.paintedNoRig = [...new Set(painted)];
  check(rows.length > 0, "no wild beast was in the world to compare footprints against");
}

console.log(JSON.stringify({ ...results, fails }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
