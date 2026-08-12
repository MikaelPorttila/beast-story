// Verifies the mob-spawn safe zones (src/world/safe-zones.ts): the wild
// population never APPEARS in a settlement or in a point of interest that asked
// for a keep-out — and is still free to chase the player into one.
//
// Usage: bun tools/test-safezone.mjs      (dev server must be up)
//        ...or as sections inside `bun tools/suite.mjs` — same code either way.
//
// FAST-FORWARDED, SHARED-SESSION: the sampling loops advance simulated time
// through `__dbgAdvance` (see tools/suite/harness.mjs) instead of sleeping, and
// the boot is the suite's. Measured real-time before the conversion: 69 s.
//
// THE RUN IS A PAIR, and neither half means anything alone. "No enemy ever
// appeared inside the Encampment" is equally true of a working keep-out and of
// a world where nothing spawned at all, or where the hero was parked somewhere
// the spawner never reached; "an enemy walked into the Encampment" is equally
// true of a chase and of a keep-out that does nothing. So the same hero, in the
// same world, is measured twice: standing OUTSIDE the disc, where nothing may
// APPEAR inside it while spawns happen freely outside, and then standing IN THE
// MIDDLE of it, where something has to follow him in.
//
// WHAT "APPEARS" MEANS, and why it is the assertion rather than "stands". A
// safe zone is a SPAWN rule, not a wall (AGENTS.md says it in those words, and
// section `chase` below depends on it) — so an animal that spawned legally just
// outside the disc and wandered in on its own legs has broken no rule. The
// first version of this probe asserted no enemy ever STOOD inside the disc, and
// it failed on main against exactly that: a peckit 24.23 from the centre of a
// 29.76 disc, doing what `pickWanderGoal` has always allowed. The honest
// assertion is the one this header always claimed: nothing may APPEAR inside —
// an enemy's first sighting must be outside the disc. Sightings are 0.7
// simulated seconds apart and nothing wild covers 5 units in that, so an animal
// legally crossing the rim is seen outside it first; only a spawn materialising
// inside has no such history.
//
// WHY THE FIRST HALF PARKS THE HERO 40 UNITS OUT. A candidate lands 25-60 from
// the player (SPAWN_RING_MIN/MAX in src/combat/index.ts), so at 40 from the
// town centre the ring sweeps straight across the settlement and a broken
// keep-out has every chance to be caught — while the hero himself is far enough
// outside that anything which aggroes him is walking AWAY from the town rather
// than through it.
//
// Exits non-zero on failure.

/** Set by the census section; read by everything after it. */
let census = null;
let town = null;
let seat = null;

const enemies = async (ctx) => (await ctx.ev(() => window.__dbgBodies?.())).enemies;

/** Every live enemy, with its distance from the town centre. */
async function census2(ctx) {
  const list = await enemies(ctx);
  return list
    .filter((e) => !e.isDead)
    .map((e) => ({
      species: e.species,
      x: e.x,
      z: e.z,
      d: Math.hypot(e.x - seat.x, e.z - seat.z),
    }));
}

export const name = "safezone";
export const sections = [
  // -------------------------------------------------------------------------
  {
    id: "census",
    run: async (ctx) => {
      // Who claimed a disc, and how wide.
      census = await ctx.ev(() => window.__dbgSafeZones?.());
      ctx.check(!!census, "__dbgSafeZones is not there — nothing below can run");
      if (!census) {
        throw new Error("no census");
      }

      // A town RIDING A CARRIER registers no disc, by design: a spawn rule is a
      // disc on the GROUND, and the flying town is not on it — see the "No
      // keep-out" note on the town record in world/sky-island.ts. The first
      // version of this probe asserted every town in the registry had a zone and
      // went red on main the day the carried town joined the registry; the
      // assertion now covers the towns the rule covers.
      const carrierIds = new Set(await ctx.ev(() => window.__dbgCarriers().all.map((c) => c.id)));
      const grounded = census.towns.filter((t) => !carrierIds.has(`carrier:town:${t.id}`));

      const byId = new Map(census.zones.map((z) => [z.id, z]));
      const perTown = grounded.map((t) => {
        const zone = byId.get(`town:${t.id}`);
        return { id: t.id, outerRadius: t.outerRadius, zone: zone?.radius ?? null };
      });
      ctx.res.census = {
        zones: census.zones,
        perTown,
        carried: census.towns.length - grounded.length,
        dens: census.zones.filter((z) => z.id.startsWith("den:")).length,
      };

      ctx.check(
        grounded.length > 0,
        "no ground towns in this world — the default arm cannot be tested",
      );
      for (const t of perTown) {
        // A GROUND TOWN HAS ONE BY DEFAULT: no shipped town authors
        // `noSpawnRadius`, so every one of these is the derived value,
        // `outerRadius` + the margin.
        ctx.check(t.zone !== null, `"${t.id}" has no safe zone — a settlement gets one by default`);
        ctx.check(
          t.zone !== null && Math.abs(t.zone - (t.outerRadius + 6)) < 0.01,
          `"${t.id}" zone ${t.zone} is not outerRadius ${t.outerRadius} + the 6-unit margin`,
        );
      }
      // A POINT OF INTEREST DOES NOT, unless a designer said so. The skill dens
      // say nothing (DEN_NO_SPAWN_RADIUS is 0, and a 0 registers no zone at all);
      // the zone gateway asks for 12 in main.ts.
      ctx.check(
        ctx.res.census.dens === 0,
        `${ctx.res.census.dens} skill dens claimed a zone — the default for a POI is none`,
      );
      const gate = byId.get("landmark:gateway");
      ctx.check(
        !!gate,
        "the zone gateway claimed no keep-out — the designer-set POI arm is untested",
      );
      ctx.check(
        !gate || gate.radius === 12,
        `the gateway's keep-out is ${gate.radius}, expected 12`,
      );

      // The seat for the sections below: the widest GROUND keep-out.
      town = grounded.reduce((a, b) => (a.noSpawnRadius > b.noSpawnRadius ? a : b));
      seat = census.zones.find((z) => z.id === `town:${town.id}`);
      ctx.check(!!seat, `the widest ground town "${town.id}" has no zone to measure against`);
      if (!seat) {
        throw new Error("no seat");
      }
    },
  },

  // -------------------------------------------------------------------------
  {
    id: "rim",
    run: async (ctx) => {
      // The query itself, at the rim.
      const r = seat.radius;
      const at = (d) =>
        ctx.ev(([a, b]) => window.__dbgSafeZones?.(a, b).blocks, [seat.x + d, seat.z]);
      ctx.res.rim = {
        town: town.id,
        x: seat.x,
        z: seat.z,
        radius: r,
        centre: await at(0),
        inside: await at(r - 0.5),
        outside: await at(r + 0.5),
      };
      ctx.check(ctx.res.rim.centre === true, "the middle of a town does not block a spawn");
      ctx.check(ctx.res.rim.inside === true, `${r - 0.5} from the middle does not block a spawn`);
      ctx.check(
        ctx.res.rim.outside === false,
        `${r + 0.5} from the middle still blocks — the disc is too wide`,
      );
    },
  },

  // -------------------------------------------------------------------------
  {
    id: "noSpawnInside",
    run: async (ctx) => {
      // The hero outside: nothing may APPEAR inside the disc.
      //
      // 40 units out on the side away from the world's own spawn point, so the
      // ring sweeps the town and the hero is not standing in his own 20-unit
      // start disc.
      const a = Math.atan2(seat.x - 0, seat.z - 0);
      const hx = seat.x + Math.sin(a) * 40;
      const hz = seat.z + Math.cos(a) * 40;
      await ctx.tp(hx, hz);
      await ctx.adv(2);

      let worst = Infinity; // closest any enemy ever came to the middle
      let worstAt = null;
      let seenOutside = 0; // the control: spawns DID happen near the town
      let appeared = null; // an enemy whose FIRST sighting was inside
      let ambledIn = 0; // legal rim-crossers, reported not asserted
      let samples = 0;
      // PRIME THE HISTORY before the watch starts. An enemy already standing
      // inside the disc at sample 0 has an unknown past — in a shared suite the
      // world has been running for minutes and a legal walk-in can be anywhere —
      // and "appears" is a claim about what happens DURING the watch. Without
      // this, the first sample reads every pre-existing body as a spawn, which
      // is exactly the kind of vacuous red the old ever-stood-inside assertion
      // produced from the other direction. The rim section above already proves
      // the spawn QUERY refuses the disc; this section proves nothing
      // materialises in it over 42 simulated seconds.
      let prev = await census2(ctx);
      for (let i = 0; i < 60; i++) {
        await ctx.adv(0.7);
        const live = await census2(ctx);
        samples++;
        for (const e of live) {
          if (e.d < worst) {
            worst = e.d;
            worstAt = e;
          }
          if (e.d < seat.radius + 25) {
            seenOutside++;
          }
          if (e.d < seat.radius) {
            // Inside the disc: legal if this body was seen before (it walked in —
            // sightings are 0.7 simulated seconds apart and nothing wild moves 5
            // units in that), a spawn violation if it has no history.
            const seenBefore = prev.some(
              (p) => p.species === e.species && Math.hypot(p.x - e.x, p.z - e.z) < 5,
            );
            if (seenBefore) {
              ambledIn++;
            } else {
              appeared = { ...e, sample: i };
            }
          }
        }
        prev = live;
      }
      ctx.res.noSpawnInside = {
        heroX: +hx.toFixed(2),
        heroZ: +hz.toFixed(2),
        fromTown: 40,
        radius: seat.radius,
        samples,
        closestApproach: Number.isFinite(worst) ? +worst.toFixed(2) : null,
        closestWas: worstAt,
        sightingsNearTown: seenOutside,
        ambledInSightings: ambledIn,
        appearedInside: appeared,
      };
      // THE CONTROL FIRST: without it, an empty world passes the claim below and
      // says nothing whatever.
      ctx.check(
        seenOutside > 0,
        "no enemy was ever seen within 25 units of the town rim — nothing spawned, so the run is empty",
      );
      ctx.check(
        appeared === null,
        `an enemy APPEARED ${appeared?.d?.toFixed(2)} from the middle of ${town.id} ` +
          `(sample ${appeared?.sample}, ${appeared?.species}) with no history outside its ` +
          `${seat.radius} keep-out — that is a spawn inside the disc, not a walk-in`,
      );
    },
  },

  // -------------------------------------------------------------------------
  {
    id: "chase",
    run: async (ctx) => {
      // The hero inside: a hunter follows him in.
      //
      // THE HERO HAS TO BE LED IN, and teleporting him to the middle and waiting
      // is exactly what does not work: it was tried, and the closest anything
      // came in 31 samples was 31.08 — an idle wanderer that had never noticed
      // him. An enemy 40 units away has no target (aggro is a radius about the
      // animal, `enemy:` content in core.json), so the hero must be walked up to
      // one to acquire it and then walked into the town in hops short enough to
      // stay inside the leash. What that leaves is a genuine chase, which is the
      // thing being asserted.
      const start = (await census2(ctx)).sort((a, b) => a.d - b.d)[0] ?? null;
      let best = Infinity;
      let arrived = null;
      const hops = [];
      if (start) {
        // Stand beside it and let `retarget` run (it ticks every 0.22 s).
        await ctx.tp(start.x + 2.5, start.z);
        await ctx.adv(1.5);
        // Then walk the hero to the middle, 4 units at a time. Short hops on
        // purpose: a hero who jumps the whole way spends the leash in one step
        // and the animal gives up rather than following.
        const steps = Math.ceil(start.d / 4);
        for (let i = 1; i <= steps; i++) {
          const k = i / steps;
          await ctx.tp(start.x + (seat.x - start.x) * k, start.z + (seat.z - start.z) * k);
          await ctx.adv(1.4);
          for (const e of await census2(ctx)) {
            if (e.d < best) {
              best = e.d;
              arrived = e;
            }
          }
          hops.push(+best.toFixed(2));
          if (best < seat.radius * 0.8) {
            break;
          }
        }
        // ...and hold in the middle, for whatever is still on its way.
        for (let i = 0; i < 20 && best >= seat.radius * 0.8; i++) {
          await ctx.tp(seat.x, seat.z);
          await ctx.adv(0.7);
          for (const e of await census2(ctx)) {
            if (e.d < best) {
              best = e.d;
              arrived = e;
            }
          }
        }
      }
      ctx.res.chase = {
        radius: seat.radius,
        led: start,
        closestPerHop: hops,
        closestApproach: Number.isFinite(best) ? +best.toFixed(2) : null,
        closestWas: arrived,
      };
      ctx.check(!!start, "no live enemy to lead in — the previous section left nothing standing");
      // THE OTHER HALF OF THE PAIR. A zone is a spawn rule, not a wall: something
      // hunting the player has to be able to walk over it. If this ever fails
      // legitimately the fix is in the AI, not in the zone.
      ctx.check(
        Number.isFinite(best) && best < seat.radius,
        `nothing followed the hero into ${town.id} (closest ${best.toFixed(2)} of ${seat.radius}) — ` +
          "a safe zone must not be a wall",
      );
    },
  },
];

if (import.meta.main) {
  const { soloRun } = await import("./suite/harness.mjs");
  await soloRun({ name, sections });
}
