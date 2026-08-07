// Verifies MOVING REFERENCE FRAMES (src/world/carriers.ts) and the one thing
// that implements them today, the flying town (src/world/sky-island.ts).
//
// Usage: bun tools/test-carrier.mjs      (dev server must be up)
//        ...or as sections inside `bun tools/suite.mjs` — same code either way.
//
// FAST-FORWARDED, SHARED-SESSION. Every wall-clock wait this file ever had is
// an `adv()` — `__dbgAdvance` in main.ts drains the same simulation slices the
// frame loop would have drained, synchronously — and the boot is the suite's,
// paid once for every converted probe rather than once per probe. Run solo it
// boots its own page through the same harness; see tools/suite/harness.mjs for
// the contract. Measured before the conversion: 65.7 s. After `adv` alone:
// 18.6 s. In the suite the boot amortises away too.
//
// THE WHOLE FEATURE IS INVISIBLE TO A POSITION AND TO A SCREENSHOT, which is
// what this file is shaped around. "The hero is at (261, 86, -79)" says nothing
// — he is there whether he is riding the island or falling past it — and a still
// of a man on a deck is the same still either way. The question is whether he is
// in the same place ON THE DECK he was ten seconds ago while the deck has moved,
// so every assertion here is about `onDeck`: his position expressed in the
// island's own coordinates, reported by `__dbgCarriers()`.
//
// IT IS A PAIR AT ONE COLUMN, twice over, and neither half means anything alone:
//
//   RIDING     parked on the deck, the island must travel and `onDeck` must not.
//              On its own this passes in a world where the island never moved.
//   MOVING     the same run therefore requires the island to have covered real
//              ground — if it is standing still there is nothing to be carried by.
//   OFF        stepped past the rim, `riding` must go null and the hero must
//              fall. Without this, "onDeck never changes" would also pass for a
//              hero glued to a frame he can never leave, which is the opposite
//              defect and the one the issue explicitly asks against: jumping off
//              returns the actor to regular world space.
//   UNDER      parked on the ground BELOW the island, he must not attach and
//              must not be dragged. This is the assertion that would have caught
//              a containment test that forgot its `y` — the failure mode where
//              an island passing overhead teleports a walker into the sky.
//
// Section `residents` is the people and `compass` is the chip, which are the two
// things the issue names besides the movement itself. Sections `keel`, `shoved`,
// `lands` and `wood` are issue #80: the frame is a BODY, not a surface.
//
// Exits non-zero on failure.

import { bondAll } from './suite/harness.mjs';

/** The island, live. Every section reads it fresh — it is somewhere else now. */
const carriers = (ctx) => ctx.ev(() => window.__dbgCarriers());
const pos = (ctx) => ctx.ev(() => window.__dbgPlayerPos());

/** Set by the first section, read by the ones that only need id/radius. */
let island = null;


export const name = 'carrier';
export const sections = [

  // A PARTY TO FLY. Since issue #4 a new game is bonded to nothing, and the
  // sections below put a FLYER under the island and against its keel. See
  // `bondAll` for why each module asks for this itself.
  { id: 'party', run: async (ctx) => { await bondAll(ctx); } },

  // -------------------------------------------------------------------------
  { id: 'exists', run: async (ctx) => {
    // There is one, and it is going somewhere.
    const first = await carriers(ctx);
    ctx.check(first.all.length === 1, `expected exactly one carrier, got ${first.all.length}`);
    island = first.all[0] ?? null;
    ctx.check(!!island, 'no carrier in the world at all');
    if (!island) throw new Error('nothing to test against');
    ctx.res.carrier = {
      id: island.id, radius: island.radius, y: island.y, step: island.step,
    };
    // The keel is 27 units deep and the mountains it has to clear are 40-60
    // high, so anything under ~70 means the altitude rule is not running.
    ctx.check(island.y >= 70, `island is at y ${island.y} — too low to clear the terrain`);
  } },

  // -------------------------------------------------------------------------
  { id: 'riding', run: async (ctx) => {
    // Parked on the deck: the world moves, the hero's place on it does not.
    //
    // BARE TURF, FOUND RATHER THAN ASSUMED. This used to aim at a fixed world
    // offset (0.62 r along +X) with a comment explaining it dodged the tower —
    // but the island ROTATES, so which local column sits under a fixed world
    // point is the yaw at that instant, and sometimes it is a tree: the crown's
    // top is ten units over the turf, a hero dropped at +8 is BELOW it and
    // therefore outside the ride volume, and he falls straight through the
    // island. The probe only ever passed by luck of the pose — the last
    // real-time baseline run had in fact landed him on a ROOF (onDeck.y 8.95)
    // and attached anyway.
    //
    // So: walk bearings on the 0.62 r ring, parked WELL ABOVE the ride ceiling
    // so the scan itself cannot attach, and take the first column where the top
    // of what is standing IS the turf — deckTop equal to surface means nothing
    // is built or planted there. Both are live queries at the hero's own
    // column, which is what makes the scan a few teleports and no waiting.
    //
    // The drop from +8 is deliberate: it lands him through the same attach path
    // a flyer takes, rather than starting him already at rest on a surface.
    let spot = null;
    for (let k = 0; k < 16 && !spot; k++) {
      const isl = (await carriers(ctx)).all[0];
      const ang = (k / 16) * Math.PI * 2;
      const sx = isl.x + Math.sin(ang) * isl.radius * 0.62;
      const sz = isl.z + Math.cos(ang) * isl.radius * 0.62;
      await ctx.tp(sx, sz, isl.y + 40);
      const c = (await carriers(ctx)).all[0];
      if (c.deckTop !== null && c.surface !== null && Math.abs(c.deckTop - c.surface) < 0.1) {
        spot = { x: sx, z: sz, y: isl.y + 8 };
      }
    }
    ctx.check(!!spot, 'no bare turf column found on the 0.62 r ring — is the deck all buildings?');
    await ctx.tp(spot.x, spot.z, spot.y);
    await ctx.adv(1.6);
    const a = await carriers(ctx);
    const before = a.all[0];
    const startPos = await pos(ctx);
    ctx.check(a.riding === island.id, `hero did not attach to the deck (riding: ${a.riding})`);
    ctx.check(before.deckTop !== null, 'no deck under the hero after landing on the island');

    await ctx.adv(9);
    const b = await carriers(ctx);
    const after = b.all[0];
    const endPos = await pos(ctx);

    const travelled = Math.hypot(after.x - before.x, after.z - before.z);
    const drift = Math.hypot(after.onDeck.x - before.onDeck.x, after.onDeck.z - before.onDeck.z);
    ctx.res.riding = {
      islandTravelled: +travelled.toFixed(2),
      heroWorldMoved: +Math.hypot(endPos.x - startPos.x, endPos.z - startPos.z).toFixed(2),
      driftOnDeck: +drift.toFixed(3),
      onDeckBefore: before.onDeck,
      onDeckAfter: after.onDeck,
      stillRiding: b.riding,
    };

    // THE OTHER HALF OF THE PAIR: an island that did not move carries nothing,
    // and every number below it would be trivially satisfied. AGAINST THE
    // CRUISE, not a number picked once: the island does 1.0 units/s and takes a
    // few seconds to accelerate onto a heading, so nine seconds is seven or
    // eight units of real travel; the assertion only has to be big enough that
    // a STOPPED island fails it.
    ctx.check(travelled > 4,
      `the island only travelled ${travelled.toFixed(2)} units in 9 s — nothing to be carried by`);
    // ...and the feature. A standing hero drifts by the settling of his own
    // physics and nothing else; a whole unit over nine seconds would be the
    // frame sliding out from under him.
    ctx.check(drift < 1.0,
      `hero drifted ${drift.toFixed(2)} units across the deck while standing still`);
    ctx.check(b.riding === island.id, 'hero fell off the island while standing still on it');
  } },

  // -------------------------------------------------------------------------
  { id: 'steppedOff', run: async (ctx) => {
    // Off the rim: back to world space, and falling.
    const a = (await carriers(ctx)).all[0];
    // Just past the rim, at deck height. `radius` is the ride volume's own
    // bound, so a body a couple of units outside it is outside by the frame's
    // own rule rather than by a number this file invented.
    await ctx.tp(a.x + a.radius + 3, a.z, a.y + 4);
    await ctx.adv(1.2);
    const b = await carriers(ctx);
    const p1 = await pos(ctx);
    await ctx.adv(0.9);
    const p2 = await pos(ctx);
    ctx.res.steppedOff = {
      riding: b.riding,
      y1: +p1.y.toFixed(2), y2: +p2.y.toFixed(2), fell: +(p1.y - p2.y).toFixed(2),
    };
    ctx.check(b.riding === null, `hero is still riding ${b.riding} from outside the island`);
    ctx.check(p2.y < p1.y - 3,
      `hero did not fall after leaving the island (${p1.y.toFixed(1)} -> ${p2.y.toFixed(1)})`);
  } },

  // -------------------------------------------------------------------------
  { id: 'underneath', run: async (ctx) => {
    // Underneath it: not attached, not dragged.
    const a = (await carriers(ctx)).all[0];
    // On the ground directly below the middle of the island — `__dbgTp` with no
    // y resolves the height field, which is exactly the case that must be immune.
    await ctx.tp(a.x, a.z);
    await ctx.adv(0.6);
    const b = await carriers(ctx);
    const p1 = await pos(ctx);
    await ctx.adv(4);
    const p2 = await pos(ctx);
    const moved = Math.hypot(p2.x - p1.x, p2.z - p1.z);
    const c = (await carriers(ctx)).all[0];
    ctx.res.underneath = {
      riding: b.riding,
      heroMoved: +moved.toFixed(3),
      islandMoved: +Math.hypot(c.x - a.x, c.z - a.z).toFixed(2),
      heroY: +p2.y.toFixed(2),
      deckY: c.y,
    };
    ctx.check(b.riding === null,
      'hero standing on the GROUND under the island was attached to it — '
      + 'the containment test has lost its vertical bound');
    // MEASURED AGAINST THE ISLAND'S OWN TRAVEL, not against zero. A hero who is
    // being carried moves EXACTLY as far as the frame does, so the
    // discriminator is the ratio; a fixed small bound fails on things that have
    // nothing to do with carriers — measured 1.56 units in 4 s standing in open
    // country, which is a wild spawn's knockback and settling onto a slope,
    // against an island that covered 10.88 in the same window.
    ctx.check(moved < ctx.res.underneath.islandMoved * 0.35,
      `hero on the ground moved ${moved.toFixed(2)} units while the island overhead `
      + `moved ${ctx.res.underneath.islandMoved} — that is being dragged, not standing`);
  } },

  // -------------------------------------------------------------------------
  { id: 'residents', run: async (ctx) => {
    // The residents travel with it.
    const a = (await carriers(ctx)).all[0];
    const npcs = await ctx.ev(() => window.__dbgNpcs());
    const crew = npcs.all.filter((n) => n.id.startsWith('sky-'));
    const offsets = crew.map((n) => +Math.hypot(n.x - a.x, n.z - a.z).toFixed(2));
    await ctx.adv(5);
    const b = (await carriers(ctx)).all[0];
    const npcs2 = await ctx.ev(() => window.__dbgNpcs());
    const crew2 = npcs2.all.filter((n) => n.id.startsWith('sky-'));
    const offsets2 = crew2.map((n) => +Math.hypot(n.x - b.x, n.z - b.z).toFixed(2));
    ctx.res.residents = {
      count: crew.length,
      islandMoved: +Math.hypot(b.x - a.x, b.z - a.z).toFixed(2),
      offsetsBefore: offsets,
      offsetsAfter: offsets2,
      heights: crew2.map((n) => +n.y.toFixed(2)),
    };
    ctx.check(crew.length === 3, `expected 3 skyfolk, found ${crew.length}`);
    // They are placed in the island's frame and republished in world
    // coordinates every slice, so their distance FROM THE ISLAND is the
    // invariant — it is a placement, and it must not change while the world
    // position does.
    for (let i = 0; i < offsets.length; i++) {
      ctx.check(Math.abs(offsets2[i] - offsets[i]) < 1.0,
        `${crew[i].id} moved ${(offsets2[i] - offsets[i]).toFixed(2)} relative to the island`);
      ctx.check(offsets2[i] < a.radius,
        `${crew[i].id} is ${offsets2[i]} from the island centre, outside its ${a.radius} rim`);
    }
    for (const n of crew2) {
      ctx.check(n.y > b.y - 5, `${n.id} is at y ${n.y}, below the deck at ${b.y}`);
    }
  } },

  // -------------------------------------------------------------------------
  { id: 'compass', run: async (ctx) => {
    // The compass knows where it is now.
    //
    // Somewhere with a clear view, and NOT under the island — the bearing to a
    // marker you are standing on top of swings wildly and says nothing. The
    // compass is HUD state written in frame(), which is why `adv` ends by
    // letting a real frame present — see the harness.
    const a = (await carriers(ctx)).all[0];
    await ctx.tp(a.x - 160, a.z - 160);
    await ctx.adv(0.7);
    const c1 = await ctx.ev(() => window.__dbgCompass());
    const m1 = c1.markers.find((m) => m.id === 'town:skyhaven');
    await ctx.adv(6);
    const c2 = await ctx.ev(() => window.__dbgCompass());
    const m2 = c2.markers.find((m) => m.id === 'town:skyhaven');
    const b = (await carriers(ctx)).all[0];
    ctx.res.compass = {
      marker: m1 ? m1.id : null,
      relBefore: m1 ? m1.rel : null,
      relAfter: m2 ? m2.rel : null,
      islandMoved: +Math.hypot(b.x - a.x, b.z - a.z).toFixed(2),
    };
    ctx.check(!!m1, 'no compass chip for the flying town');
    // The hero has not moved and the camera has not turned, so any change in
    // the chip's bearing is the TOWN having moved — which is the whole
    // assertion. A chip built from a placement-time snapshot reads exactly 0.
    if (m1 && m2) {
      ctx.check(Math.abs(m2.rel - m1.rel) > 0.5,
        `the flying town's compass chip did not move (${m1.rel} -> ${m2.rel}) `
        + `while the town travelled ${ctx.res.compass.islandMoved} units`);
    }
  } },

  // -------------------------------------------------------------------------
  { id: 'keel', run: async (ctx) => {
    // It is a SLAB: you cannot fly in through the keel.
    //
    // Issue #80, first half — a photograph of a mount sitting inside the rock.
    // The deck was the only face the frame had, and `CarrierRide.support` is
    // gated on being attached, so a flyer climbing at the underside was flying
    // at nothing.
    //
    // THE ASSERTION IS THE SLAB, not an altitude: at every sample inside the
    // island's footprint the animal is on ONE SIDE of the pair (under the keel
    // or on the deck) and never between them. That holds whatever the island's
    // own altitude is doing, which a fixed number would not.
    await ctx.ev(() => window.__dbgRide('off'));
    const a = (await carriers(ctx)).all[0];
    // On the ground under the middle of it — the deepest part of the keel and
    // the straightest line at the island there is.
    await ctx.tp(a.x, a.z);
    await ctx.adv(0.6);
    const said = await ctx.ev(() => window.__dbgRide('galebird'));
    const m0 = await ctx.ev(() => window.__dbgMount());
    ctx.check(m0.mounted && m0.locomotion === 'flying',
      `could not get a flyer under the island: ${said}`);

    // STARTED IN THE AIR UNDER THE KEEL, and the altitude is read off the frame
    // rather than picked: the deck cruises around 190 and the keel is most of a
    // hundred units of rock below it, so a galebird climbing at 7 units/s
    // spends the whole run climbing and never reaches the thing being tested.
    // `keel` is a column query and does not care where the asker is, so it can
    // be read from the ground. 25 units is three seconds of climb.
    const start = (await carriers(ctx)).all[0];
    ctx.check(start.keel !== null, 'no keel under the middle of the island');
    await ctx.tp(a.x, a.z, start.keel - 25);
    await ctx.adv(0.6);

    const samples = [];
    await ctx.page.keyboard.down('Space');
    for (let i = 0; i < 24; i++) {
      await ctx.adv(0.5);
      const c = await carriers(ctx);
      const mm = await ctx.ev(() => window.__dbgMount());
      samples.push({
        y: mm.bodyY,
        keel: c.all[0].keel,
        surface: c.all[0].surface,
        deck: c.all[0].deckTop,
        riding: c.riding,
      });
    }
    await ctx.page.keyboard.up('Space');
    await ctx.adv(0.4);

    const under = samples.filter((s) => s.keel !== null);
    // Between the KEEL and the TURF — `surface`, not `deckTop`, which is the
    // top of whatever is standing in the column. The animal is inside the rock,
    // which is the bug.
    const inside = under.filter((s) => s.y > s.keel + 0.5 && s.y < s.surface - 0.5);
    const climbed = samples[samples.length - 1].y - samples[0].y;
    const last = samples[samples.length - 1];
    ctx.res.keel = {
      samples: samples.length,
      underTheIsland: under.length,
      insideTheRock: inside.length,
      climbed: +climbed.toFixed(2),
      endY: last.y, endKeel: last.keel, endSurface: last.surface,
      worst: inside[0] ?? null,
    };
    // THE OTHER HALF OF THE PAIR, twice: the hold has to have been a real
    // climb, and it has to have been made where the island actually is. Without
    // either, "he never got inside the rock" is what a probe that pressed
    // nothing reports.
    ctx.check(climbed > 15,
      `the flyer only climbed ${climbed.toFixed(1)} units in 12 s — nothing was tested`);
    ctx.check(under.length > 12,
      `only ${under.length} of ${samples.length} samples were under the island at all`);
    ctx.check(inside.length === 0,
      `the flyer was inside the rock on ${inside.length} samples, first at y `
      + `${inside[0]?.y} between keel ${inside[0]?.keel} and turf ${inside[0]?.surface}`);
    // And he is held AGAINST the keel rather than stopped somewhere below it by
    // the ordinary flight ceiling, which would make the run above prove nothing
    // about the island. FLY_CLEARANCE is 1.3.
    if (last.keel !== null) {
      ctx.check(last.keel - last.y < 6,
        `the climb stopped ${(last.keel - last.y).toFixed(1)} units under the keel — `
        + 'something other than the island is the ceiling here');
    }
    await ctx.ev(() => window.__dbgRide('off'));
  } },

  // -------------------------------------------------------------------------
  { id: 'shoved', run: async (ctx) => {
    // Caught by the flank: pushed OUT, never lifted over.
    //
    // The first fix for the keel resolved a body found inside the mass upward,
    // onto the deck. That is a teleport onto the island — the report's own
    // complaint read backwards — and it is what a body being run down by a
    // moving mountain must not get. The mass is refused horizontally and
    // resolved SIDEWAYS: the island carries you along its flank rather than
    // swallowing you or handing you the summit.
    //
    // Staged with a teleport because the honest version — hovering in the
    // island's path until it arrives — is a wait on a wandering frame, and the
    // physics cannot tell the difference: both are "this slice, a body is in
    // the rock".
    await ctx.ev(() => window.__dbgRide('off'));
    const a = (await carriers(ctx)).all[0];
    // MOUNT FIRST AND TELEPORT SECOND. Mounting snaps the rider onto the
    // animal, which is standing on the ground wherever it was following him
    // from, so a teleport before it is a teleport of somebody who is about to
    // be moved. `__dbgTp` carries the pair (see its note in main.ts), which is
    // why the second one holds.
    await ctx.tp(a.x, a.z);
    await ctx.adv(0.5);
    const said = await ctx.ev(() => window.__dbgRide('galebird'));
    ctx.check((await ctx.ev(() => window.__dbgMount())).mounted, `no flyer: ${said}`);
    // Halfway out along the radius and well under the turf: inside the cliff,
    // on the keel's shoulder rather than at its thin rim.
    //
    // THE DEPTH IS MEASURED, NOT ASSUMED. It was `a.y - 20`, twenty under the
    // island's height as read BEFORE the mount and two teleports — and the
    // island is cruising the whole while. Measured, that landed the flyer at
    // y 170 against a keel of 170.8: three-quarters of a metre UNDER the rock
    // rather than inside it, and the section then reported that it had not been
    // staged. Re-read at the column it is actually going to, and put it a
    // quarter of the way up the rock from the keel there.
    const staged = a.radius * 0.5;
    await ctx.tp(a.x + staged, a.z, a.y + 40);
    await ctx.adv(0.2);
    const here = (await carriers(ctx)).all[0];
    const depth = here.keel !== null && here.surface > here.keel
      ? here.keel + Math.max(4, (here.surface - here.keel) * 0.25)
      : a.y - 20;
    await ctx.tp(a.x + staged, a.z, depth);
    await ctx.adv(0.2);
    const c0 = (await carriers(ctx)).all[0];

    await ctx.adv(2);
    const s1 = await carriers(ctx);
    const c1 = s1.all[0];
    const p1 = await pos(ctx);
    const m1 = await ctx.ev(() => window.__dbgMount());
    const d1 = Math.hypot(p1.x - c1.x, p1.z - c1.z);
    const inRock = c1.keel !== null && m1.bodyY > c1.keel && m1.bodyY < c1.surface;
    ctx.res.shoved = {
      startedInRock: c0.keel !== null && depth > c0.keel && depth < c0.surface,
      fromCentre: +staged.toFixed(2), toCentre: +d1.toFixed(2), radius: c1.radius,
      y: m1.bodyY, surface: c1.surface, keel: c1.keel, stillInRock: inRock,
      riding: s1.riding,
    };
    ctx.check(ctx.res.shoved.startedInRock,
      `the flyer was not staged inside the rock (y ${depth}, keel ${c0.keel}, turf ${c0.surface})`);
    ctx.check(!inRock, `still inside the rock after 2 s at y ${m1.bodyY} `
      + `(turf ${c1.surface}, keel ${c1.keel})`);
    // THE TWO HALVES OF "PUSHED, NOT LIFTED". Outward, and not up: a body that
    // ended over the turf got the teleport this section exists to forbid, and
    // one that ended no further out than it started was not pushed at all.
    // AGAINST WHERE HE WAS PUT, not against a reading taken after the fact: the
    // march is 120 units a second, so by the time a probe has asked twice it is
    // measuring the tail of the push rather than the push.
    ctx.check(d1 > staged + 5,
      `the flyer was not pushed outward: staged at ${staged.toFixed(1)}, ended at `
      + `${d1.toFixed(1)} units from the centre`);
    ctx.check(!(m1.bodyY > c1.surface && c1.surface !== null),
      `the flyer was lifted onto the deck (y ${m1.bodyY} over turf ${c1.surface})`);
    ctx.check(s1.riding === null,
      `the flyer ended up riding ${s1.riding} — it was shoved onto the town`);
  } },

  // -------------------------------------------------------------------------
  { id: 'lands', run: async (ctx) => {
    // ...and a flyer still LANDS on it.
    //
    // The other half of every refusal above, and the one that fails if the mass
    // is drawn too generously: an island you cannot fly into is worth nothing
    // if it is also an island you cannot fly ONTO. The approach is from above,
    // which is the only one there is, and what has to happen is the ordinary
    // one — `carry` attaches him and `floorFor` puts him down on the turf.
    const a = (await carriers(ctx)).all[0];
    // Over open grass rather than the middle: the tower is in the middle, and a
    // flyer landing on a roof is a different (and correct) outcome that would
    // make the height assertion below mean nothing. Ten units up, inside
    // RIDE_CEILING.
    await ctx.tp(a.x + a.radius * 0.5, a.z, a.y + 10);
    await ctx.adv(1.2);
    const attached = await carriers(ctx);
    // A FLYER HOLDS ITS ALTITUDE — there is no gravity in `integrateFlying`, C
    // is the way down — so the descent is driven rather than waited for. Three
    // seconds at FLY_DIVE is 25 units against the ten he has to give up.
    await ctx.page.keyboard.down('KeyC');
    await ctx.adv(3);
    await ctx.page.keyboard.up('KeyC');
    await ctx.adv(0.4);
    const s = await carriers(ctx);
    const c = s.all[0];
    const m = await ctx.ev(() => window.__dbgMount());
    ctx.res.landed = {
      attached: attached.riding, riding: s.riding,
      y: m.bodyY, surface: c.surface, over: +(m.bodyY - c.surface).toFixed(2),
    };
    ctx.check(attached.riding === island.id,
      `the flyer did not attach over the deck (riding ${attached.riding})`);
    ctx.check(s.riding === island.id,
      `the flyer stopped riding while landing (riding ${s.riding})`);
    // FLY_CLEARANCE is 1.3: he rests ON the turf, and the dive does not put him
    // through it — which is the floor this section guards. Diving at a deck
    // that had no floor is the same fall the report photographed, from the
    // other side.
    ctx.check(m.bodyY - c.surface < 3,
      `the flyer is holding ${(m.bodyY - c.surface).toFixed(1)} units over the turf after a 3 s dive`);
    ctx.check(m.bodyY > c.surface,
      `the flyer dived through the deck (y ${m.bodyY}, turf ${c.surface})`);
    await ctx.ev(() => window.__dbgRide('off'));
  } },

  // -------------------------------------------------------------------------
  { id: 'wood', run: async (ctx) => {
    // The wood on the deck blocks.
    //
    // Issue #80, second half. A tree template carries no `solid` — the
    // overworld's canopies block through the per-chunk trunk registry, and a
    // deck has no chunk — so the island's wood was drawn and nothing more. The
    // fix makes the settlement stamp read the same `trunk` the registry reads,
    // so this asks the collision query itself, at the column each tree is
    // actually drawn in.
    const w = await ctx.ev(() => window.__dbgCarriedWood());
    const bare = w.trees.filter((t) => t.rise < 2);
    ctx.res.wood = {
      trees: w.trees.length,
      tallestBole: w.trees.reduce((m, t) => Math.max(m, t.rise), 0),
      withoutCollider: bare.length,
      deckSamples: w.sampled,
      raisedSamples: w.raised,
    };
    ctx.check(w.trees.length > 10, `only ${w.trees.length} trees on the island`);
    ctx.check(bare.length === 0,
      `${bare.length} of ${w.trees.length} island trees have nothing solid in their `
      + `column — first at ${JSON.stringify(bare[0])}`);
  } },
];

if (import.meta.main) {
  const { soloRun } = await import('./suite/harness.mjs');
  await soloRun({ name, sections });
}
