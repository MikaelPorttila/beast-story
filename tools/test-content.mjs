// Verifies the data-driven content system (src/content/, issue #60): the world
// the player walks into is cut from `src/content/data/core.json` and from
// NOTHING ELSE, it is the SAME world the TypeScript literals built, and the lazy
// half of the design — load, cross-package reference, release — works by hand.
//
// Usage: bun tools/test-content.mjs      (dev server must be up)
//
// SIX SECTIONS, AND SECTION 3 IS THE ONE THAT MATTERS.
//
//   1 zeroData      exactly one package loaded, out of the BUNDLE, and the
//                   world it produced is the real one.
//   2 cleanBoot     a healthy boot files no diagnostics at all.
//   3 identity      every migrated number is the number that shipped.
//   4 lazyPath      /content load -> reference -> /content release, at the
//                   console, which is where a human would try it.
//   5 stateUnload   releasing a package takes the DEFINITIONS and leaves the
//                   player's facts (spec §12.3).
//   6 validation    a deliberately broken asset is REPORTED, not swallowed.
//
// THE IDENTITY SECTION IS THE CONTROL, AND THE PATTERN IS TAKEN STRAIGHT FROM
// `tools/test-nature.mjs` — read its `identity` block first. There, setting a
// parameter to its own baseline must leave the census where it was, because
// without that control "grass 0 dropped the count" is equally consistent with "a
// rebuild drops the count". Here the same argument runs one level up: every
// value in core.json was COPIED from the code it replaced, so the migrated world
// must be the old world exactly, and without pinning the old numbers "the town
// registry agrees with the content registry" is equally consistent with a
// migration that moved every one of them. A registry that agrees with itself
// proves nothing.
//
// So the expected values below are LITERALS, and every one of them was read out
// of the pre-migration source with `git show HEAD:<file>` — the provenance is on
// each table. The cross-checks are deliberately taken from the WORLD's own
// objects (`__dbgTowns`, `__dbgNpcs`, the compass chips in the DOM, the resolved
// enemy roster, the nature table) rather than from `__dbgContent()`, because the
// claim under test is that the DATA REACHED THE WORLD and only the world can
// answer that.
//
// TWO THINGS IT READS THROUGH A MODULE IMPORT, and it is not a back door. The
// dev server serves the game's own modules, so `import('/src/content/index.ts')`
// from the page resolves to the module `src/main.ts` already imported and hands
// back the SAME singleton — not a second copy of it. That is asserted rather
// than assumed (`sameSingleton` in section 1): the package list read through the
// import has to equal the one `__dbgContent()` reports. It buys the two things
// no read-only hook exposes — the assets' own fields, and a writer for the state
// store — with no test-only code added to `src/`.
//
// NOTHING HERE DEPENDS ON HOW FAST THE HOST RENDERS. There is no fixed settle:
// the readiness gate polls `__dbgBoot().playing`, the talk test polls the
// world's own `inTalkRange`, and the console commands poll for their own output.
// Nothing wall-clock is printed either, so two runs produce identical JSON —
// which is what let this probe be measured onto probe.mjs's PARALLEL list.
//
// Exits non-zero.
import { launchBrowser, newPage, wait } from "./browser.mjs";
import { BASE as HOST, NO_WARMUP } from "./target.mjs";

/** One diagnostic, flattened to the fields the assertions read. */
const shape = (d) => ({
  severity: d.severity,
  code: d.code,
  assetId: d.assetId ?? null,
  field: d.field ?? null,
  message: d.message,
});

const browser = await launchBrowser();
const results = {};
const fails = [];
const check = (ok, msg) => {
  if (!ok) {
    fails.push(msg);
  }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Assert deep equality and say what moved. */
const eq = (got, want, what) =>
  check(
    same(got, want),
    `${what}: got ${JSON.stringify(got)}, pre-migration value is ${JSON.stringify(want)}`,
  );

// ---------------------------------------------------------------------------
// THE PRE-MIGRATION NUMBERS.
//
// Every literal in this block was read out of the working tree's HEAD, i.e. the
// last commit before src/content/ existed. They are not "what the game reports
// today" — that is the whole point of pinning them.
// ---------------------------------------------------------------------------

/**
 * `SITES` in `git show HEAD:src/world/towns.ts`, and where the placer put them.
 *
 * The first six fields are the table; `x`/`z` are where the seed's placement
 * lands each town given that table, read off `__dbgTowns()`. Those are in here
 * because they are the number that MOVES if the migration changed a radius, an
 * order or a waterside flag: siting is sequential and every later town is placed
 * around the earlier ones.
 *
 * THE TWO HAMLET POSITIONS ARE PLACEMENT OUTPUT, NOT MIGRATED DATA, and they
 * were re-baselined when the towns moved a kilometre apart (issue #184). The six
 * fields above them are still the pinned pre-migration table and still mean what
 * the block header says; a coordinate is what the placer DID with that table,
 * so changing the placer's search bands moves it without any datum changing.
 *
 * THE ENCAMPMENT'S IS UNTOUCHED, AND SO IS GAIN'S, which is the control and is
 * worth stating because the first attempt at that change moved both. The spur
 * band is the only one that grew; the trunk out of the camp is the length it
 * always was, so the spawn, the gate bearing and everyone standing around the
 * fire are where they have always been. If a future change to the siting moves
 * Gain, it has moved the starting country, which is a different decision from
 * moving the towns and deserves to fail this file.
 *
 * `outerRadius` is the one field with no world-side reader — see the note in
 * section 3.
 */
const CAMP_OUTER = 16.8 * Math.SQRT2; // CAMP_WALL_HALF * Math.SQRT2 = 23.7588…
const TOWNS = [
  {
    id: "encampment",
    kind: "camp",
    radius: 19,
    outerRadius: CAMP_OUTER,
    color: 0xffb45e,
    x: 121.5,
    z: 53.5,
    name: "The Encampment",
    start: true,
    waterside: false,
    order: 0,
  },
  {
    id: "redbriar",
    kind: "hamlet",
    radius: 15,
    outerRadius: 15,
    color: 0x9ad46a,
    x: -672.5,
    z: -493.5,
    name: "Redbriar Mill",
    start: false,
    waterside: true,
    order: 1,
  },
  {
    id: "stonewatch",
    kind: "hamlet",
    radius: 15,
    outerRadius: 15,
    color: 0x8fc4e8,
    x: 987.5,
    z: -288.5,
    name: "Stonewatch",
    start: false,
    waterside: false,
    order: 2,
  },
];

/**
 * `GAIN` in `git show HEAD:src/world/npc-gain.ts` (`homeOffset: 0`,
 * `acrossFocus: true`, `nameKey: 'npc.gain.name'`,
 * `talk: () => ({ …, lineKey: 'npc.gain.greeting' })`), placed by the same
 * ring search, and the sentence that key resolves to in `src/i18n/en.ts`.
 */
/**
 * SKYHAVEN, the carried settlement (issue #68) — the one town in the registry
 * that `planSettlements` never sites, because a carrier holds it up.
 *
 * There is no position here and there cannot be: it is somewhere different
 * every second, which is the whole point of it. What is pinned is what does not
 * move — that it exists, that it is carried, and that it is last in placement
 * order so the three ground towns are sited exactly as they were.
 */
const SKYHAVEN = { id: "skyhaven", carried: true, order: 3 };

/** Redbriar's miller, who closes The Mill Road (issue #149). */
const MERA = "mera";

/** The three who live on it, in load order. */
const SKYFOLK = ["sky-pilot", "sky-gardener", "sky-lamplighter"];

const GAIN = {
  id: "gain",
  name: "Deckard Gains Armstrong",
  x: 116.9,
  y: 12,
  z: 58.1,
  town: "encampment",
  fromTownCentre: 6.5,
  // WHAT HE SAYS FIRST, which is no longer his greeting and should not be.
  // Gain's `talk` list branches on quest state (core.json), first match wins,
  // and at boot the campaign's opening quest is un-offered — so the first
  // sentence out of him is the offer. The pre-migration greeting is still the
  // last row in that list and is what he says with no story package loaded;
  // tools/test-story-land.mjs is where the branching itself is asserted.
  line:
    "You slept through the interesting part. There is a Sproutle in the pen " +
    "and three taming orbs in your hand — throw them at it, and stop flinching.",
};

/**
 * Act 1's quests, in `prerequisites` order (issue #143, game-story.md §4).
 *
 * Ids only. What each one DOES is tools/test-story-land.mjs's business; here it
 * is a count, so that a package that stopped loading — or one that grew a quest
 * nobody meant to ship — is a failure in the file that pins what the boot holds.
 */
const ACT1_QUESTS = [
  "quest:land/first-light",
  "quest:land/the-first-bond",
  "quest:land/the-mill-road",
];

/** What a boot holds: the world, then the campaign that is set in it. */
const BOOT_PACKAGES = ["core", "story", "story-land"];

/**
 * The WILD BEASTS (issue #4) — ids and order only, deliberately.
 *
 * A SEPARATE LIST from `ENEMIES` below rather than more rows in it, because the
 * two are different kinds of baseline. `ENEMIES` is a pre-migration record:
 * every number in it was read off `git show HEAD:src/combat/enemies.ts` and none
 * of it may move. These are new content and have no pre-migration value to pin —
 * what is worth asserting is that they reach the world at all, and that adding
 * them disturbed neither the count nor the order of the three painted enemies.
 * Keeping the lists apart is what says that.
 *
 * TWELVE MORE OF THEM, because issue #110 asks that the player be able to
 * capture every beast in the game and fifteen of the seventeen species had no
 * way of appearing in the world at all. Every one of these wears an
 * `enemy-model/beast-<id>` builder that `combat/enemies.ts` already derives from
 * ALL_SPECIES, so none of it is new code — a wild Frostwing is the same rig as
 * the Frostwing that follows you home, which is what makes bonding hand over a
 * species without a mapping table.
 *
 * THE TWO SWIMMERS ARE NOT HERE. Finnick and Lanternfin are `locomotion:
 * 'swimming'`, and the enemy schema's only movement field is `flying` — a
 * swimmer authored as either walks the beach or hovers over it. They want water
 * spawning, which is its own piece of work.
 *
 * Order is load order, which is `core.json`'s own order.
 */
const WILD_BEASTS = [
  "wild-sproutle",
  "wild-boulderpup",
  "wild-galebird",
  "wild-emberfox",
  "wild-sparkit",
  "wild-umbrakit",
  "wild-graveborn",
  "wild-graveback",
  "wild-frostwing",
  "wild-lumimoth",
  "wild-drakelet",
  "wild-aquaxol",
  "wild-rivotter",
  "wild-coralback",
  "wild-snapclaw",
];

/**
 * `STATS`, `ENEMY_DEFS` and the three variant tables in
 * `git show HEAD:src/combat/enemies.ts`.
 *
 * The variants are pinned by ELEMENT and in order, because the element is what
 * the damage type and the shard drop key on — a variant list that shuffled would
 * change what every kill pays out while every stat here still matched.
 */
const ENEMIES = [
  {
    id: "gloopling",
    flying: false,
    hp: 32,
    atk: 6,
    speed: 2.3,
    xp: 8,
    radius: 0.5,
    height: 0.95,
    aggro: 9,
    elements: ["grass", "shadow", "water"],
  },
  {
    id: "snortle",
    flying: false,
    hp: 62,
    atk: 11,
    speed: 2.9,
    xp: 16,
    radius: 0.62,
    height: 1.15,
    aggro: 10,
    elements: ["rock", "ice", "fire"],
  },
  {
    id: "peckit",
    flying: true,
    hp: 26,
    atk: 9,
    speed: 5.2,
    xp: 12,
    radius: 0.45,
    height: 0.8,
    aggro: 12,
    elements: ["wind", "shadow", "electric"],
  },
];

/**
 * `BiomeId` in `git show HEAD:src/world/terrain.ts`, in its own order.
 *
 * Eight, and the last three are not climates: `underwater` and `deepwater` are
 * decided before any climate weight is consulted (they are the shallow and the
 * abyssal halves of a lake bed, split at DEEP_WATER_DEPTH) and `trampled` is a
 * settlement's worn yard. They are biomes because the prop scatter dispatches
 * off the id — dropping any of them in the migration would grow a meadow on a
 * lake bed.
 */
const BIOMES = [
  "plains",
  "forest",
  "beach",
  "desert",
  "snow",
  "underwater",
  "deepwater",
  "trampled",
];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Every URL the page asked for, so section 1 can prove nothing extra was fetched. */
const requested = [];

const page = await newPage(browser, { width: 1000, height: 640 });
page.on("pageerror", (e) => console.error("[pageerror]", e.message));
page.on("request", (r) => requested.push(r.url()));
// NO_WARMUP: the registry, the town/npc/enemy tables and the dev console are
// all read without drawing anything — see the note in tools/target.mjs.
await page.goto(`${HOST}/?menu=0&fs=0&${NO_WARMUP}`, { waitUntil: "load" });
await page.waitForSelector("canvas");

/**
 * A READINESS GATE, not a sleep.
 *
 * `__dbgBoot().playing` is the frame loop's own answer, so this probe is
 * indifferent to how long the world took to build — which is the property
 * tools/probe.mjs's note says a probe needs before it may be batched, and the
 * reason fourteen of its siblings may not be.
 */
async function ready(tries = 120) {
  for (let i = 0; i < tries; i++) {
    const ok = await page.evaluate(
      () =>
        typeof window.__dbgBoot === "function" &&
        typeof window.__dbgContent === "function" &&
        window.__dbgBoot().playing === true,
    );
    if (ok) {
      return true;
    }
    await wait(500);
  }
  return false;
}
if (!(await ready())) {
  console.error("the game never reached a playing frame — nothing to measure");
  await browser.close();
  process.exit(1);
}

const dbg = (fn) => page.evaluate(fn);

/**
 * Type one line at the dev console and hand back ONLY the lines it printed.
 *
 * The log accumulates for the whole session, so the reply is the delta rather
 * than a slice of the tail — and it is POLLED, because `/content load` is async
 * (the command returns `loading "x"…` and the result is printed when the chunk
 * arrives). `settle` lines is how many the caller expects; polling stops as soon
 * as they are there.
 *
 * IT CLOSES THE CONSOLE AND WAITS UNTIL IT IS ACTUALLY SHUT. DevConsole owns the
 * keyboard in the CAPTURE phase while it is open (ui/console.ts), so a console
 * that is still up eats the next `KeyE` this file sends — and the failure lands
 * three sections away, on an assertion about a sentence Gain never got the
 * chance to say. Pressing the toggle and moving on is exactly what left that
 * gap; a wall-clock `wait` after it would only make the gap narrower.
 */
async function cmd(line, expect = 1) {
  const before = await page.evaluate(
    () => document.querySelectorAll(".bs-console-log .bs-console-line").length,
  );
  await page.keyboard.press("Backquote");
  await page.waitForSelector(".bs-console-input", { visible: true });
  await page.type(".bs-console-input", line);
  await page.keyboard.press("Enter");
  let out = [];
  for (let i = 0; i < 40; i++) {
    await wait(150);
    out = await page.evaluate(
      (n) =>
        [...document.querySelectorAll(".bs-console-log .bs-console-line")]
          .slice(n)
          .map((el) => el.textContent),
      before,
    );
    if (out.length > expect) {
      break;
    }
  }
  await page.keyboard.press("Backquote");
  await consoleClosed();
  return out.join("\n");
}

/** Poll until the console is really gone, and say so if it never is. */
async function consoleClosed(tries = 40) {
  for (let i = 0; i < tries; i++) {
    const shut = await page.evaluate(() => {
      const el = document.querySelector(".bs-console");
      return !el || getComputedStyle(el).display === "none";
    });
    if (shut) {
      await page.focus("canvas").catch(() => {});
      return true;
    }
    await wait(100);
  }
  check(
    false,
    "the dev console would not close — everything after this point is " +
      "typing into it rather than playing the game",
  );
  return false;
}

// ===========================================================================
// 1. THE ZERO-DATA CLAIM
//
// The issue's hard requirement: "the initial world should always be able to run
// without any extra data being loaded." Three separate things have to be true
// for that, and each fails differently:
//
//   * exactly ONE package is loaded, and it is `core` under the `boot` lease.
//   * it came out of the BUNDLE. `source` names the provider that answered
//     (chain.ts's `sourceOf`), so `bundled:core` is the assertion — an
//     `http(...)` prefix there is the shipped game fetching its own world.
//   * the world it produced is the REAL one, read off the world's own objects.
//
// The network half is checked from the other end as well: nothing under
// `src/content/data/` may be requested at boot except `core.json` itself, and
// that one arrives as a MODULE (`?import`), which is what a static import looks
// like on a dev server. In a BUILD it is not a request at all — Rollup inlines
// it into the chunk `main.ts` is in (storage/bundled.ts says so, and says why).
// ===========================================================================
{
  const c = await dbg(() => window.__dbgContent());
  const dataReqs = requested
    .filter((u) => u.includes("/src/content/data/"))
    .map((u) => u.slice(u.indexOf("/src/content/data/")))
    .toSorted();

  // The module-import technique this file leans on, checked before it is used.
  const viaImport = await dbg(async () => {
    const { content } = await import("/src/content/index.ts");
    return {
      packages: content.packages.map((p) => p.id),
      biomes: content.all("biome").map((b) => b.id.slice(b.type.length + 1)),
      startAreas: content
        .all("biome")
        .filter((b) => b.data.startArea)
        .map((b) => b.id),
    };
  });

  results.zeroData = {
    packages: c.packages,
    assets: c.assets,
    resolved: c.resolved,
    biomes: viaImport.biomes,
    startAreaBiomes: viaImport.startAreas,
    contentDataRequests: dataReqs,
    sameSingleton: same(
      viaImport.packages,
      c.packages.map((p) => p.id),
    ),
  };

  check(
    same(
      viaImport.packages,
      c.packages.map((p) => p.id),
    ),
    "the module import did NOT reach the game's own runtime — every reading in " +
      "this file that goes through it is about a second, empty registry",
  );
  // THREE PACKAGES, AND THE SPLIT BETWEEN THEM IS THE CLAIM. `core` is the
  // WORLD — towns, people, biomes, enemies, music — and it is a module import,
  // so a build that shipped is a build whose world shipped. `story` and
  // `story-land` are the CAMPAIGN (issue #143) and they are fetched like any
  // other package; they are loaded at boot rather than at a zone edge because
  // `overworld` is the zone the game boots into (see the note in main.ts), and
  // if either fetch failed the world below would still be there to walk around
  // in with no quests in it. That is the line this section has always drawn:
  // the starting WORLD needs no request; a story is content like any other.
  eq(
    c.packages.map((p) => p.id),
    ["core", "story", "story-land"],
    "packages loaded at boot",
  );
  const core = c.packages[0] ?? {};
  check(
    core.source === "bundled:core",
    `core came from "${core.source}" — the starting world must not be a fetch`,
  );
  eq(core.leases, ["boot"], "core package leases");
  eq(core.requires, [], "core package dependencies");
  eq(
    c.packages.map((p) => p.requires),
    [[], ["core"], ["story"]],
    "the campaign's dependency chain",
  );
  eq(
    c.packages.map((p) => p.leases),
    [["boot"], ["boot"], ["boot"]],
    "every boot package is held by the boot lease, which is never released",
  );
  // RE-BASELINED TWICE, and each time the re-baseline IS the claim.
  //
  // First when music became content: the two `music` assets are the overworld's
  // playlist and the fallback an unscored area gets (src/content/types/music.ts).
  //
  // Then when the flying town shipped (issue #68): one more `town` and three
  // more `npc`, which is Skyhaven and the three people who live on it. Every
  // other count is still the PRE-MIGRATION one, and that is what this line has
  // always been for — adding a settlement must not add, drop or renumber a
  // biome or an enemy, and the three GROUND towns below must come back in the
  // order and with the values they had before any of this existed.
  //
  // Then a third time, for the wild beasts (issue #4): `enemy` goes from three
  // to six. `WILD_BEASTS` is what the three new ones are, and the assertion
  // below still names the original three FIRST and by their pre-migration
  // values — a bondable Sproutle must not have renumbered a Gloopling.
  //
  // And a fourth time, for Act 1 (issue #143): `quest` goes from 0 to
  // `ACT1_QUESTS.length`, and every other count is still the pre-migration one.
  // The campaign adds no towns — game-story.md §1 rule 4, the road planner
  // routes one trunk and two spurs — so a story package that grew a settlement
  // fails here rather than in a world with a fourth town nobody sited.
  eq(
    c.assets,
    {
      town: 4,
      npc: 5,
      biome: 8,
      enemy: 3 + WILD_BEASTS.length,
      quest: ACT1_QUESTS.length,
      music: 2,
    },
    "assets by type",
  );
  // The ground towns FIRST and unchanged — `order` decides siting and Skyhaven
  // is last — then the carried one. Asserting the whole list rather than a
  // filtered one is deliberate: a carried town that stopped reaching the world
  // is exactly as much a regression as a sited one that did.
  eq(c.resolved.towns, [...TOWNS.map((t) => t.id), SKYHAVEN.id], "towns that reached the world");
  eq(c.resolved.npcs, [GAIN.id, MERA, ...SKYFOLK], "npcs that reached the world");
  // The pre-migration three FIRST and in their old order, then the wild beasts.
  // Same argument as the towns above: asserting the whole list rather than a
  // filtered one is what makes "a wild beast stopped reaching the world" as
  // much of a regression as a Gloopling doing so.
  eq(
    c.resolved.enemies,
    [...ENEMIES.map((e) => e.id), ...WILD_BEASTS],
    "enemy species that reached the world",
  );
  eq(viaImport.biomes, BIOMES, "biome ids");
  eq(viaImport.startAreas, ["biome:plains"], "biomes flagged as the start area");
  // core.json arrives as a MODULE (`?import`) — what a static import looks like
  // on a dev server, and not a request at all in a build. The campaign's two
  // packages are ordinary fetches, and that is the whole difference between the
  // world and the story it is told in.
  eq(
    dataReqs,
    [
      "/src/content/data/core.json?import",
      "/src/content/data/story-land.json?import",
      "/src/content/data/story.json?import",
    ],
    "content data files requested at boot",
  );
}

// ===========================================================================
// 2. A CLEAN BOOT FILES NO DIAGNOSTICS
//
// The check that catches a migration that HALF worked. Everything short of
// fatal degrades with a placeholder by construction (diagnostics.ts), so a town
// with a broken layout, an unresolvable name key or a dangling reference leaves
// a world that still boots and still looks approximately right — and a finding.
// `__dbgContent().diagnostics` is the runtime's findings and the engine's own
// placers' merged, which is why one empty array covers both depths.
// ===========================================================================
{
  const c = await dbg(() => window.__dbgContent());
  const check2 = await cmd("/content check");
  results.cleanBoot = {
    ok: c.ok,
    diagnostics: c.diagnostics,
    consoleCheck: check2.split("\n").pop(),
  };
  check(c.ok === true, "the content boot reported not-ok");
  check(
    c.diagnostics.length === 0,
    `a clean boot filed ${c.diagnostics.length} diagnostic(s): ` + JSON.stringify(c.diagnostics),
  );
  check(
    /no findings/.test(check2),
    `/content check did not report a clean graph: ${JSON.stringify(check2)}`,
  );
}

// ===========================================================================
// 3. THE IDENTITY CONTROL — the migrated world is the OLD world exactly.
//
// The pattern is `tools/test-nature.mjs`'s `identity` section, one level up:
// there, a rebuild at the baseline must not move the census; here, a rewrite of
// the tables into JSON must not move a single number. Read the note at the top
// of this file for why that control is what makes the rest mean anything.
//
// Everything is read from the WORLD:
//   towns      __dbgTowns(), plus the compass chips' own `--mc`, which is
//              `TownInfo.color` on its way to the HUD (main.ts's
//              syncCompassMarkers) and the only place the resolved colour is
//              observable outside the module.
//   Gain       __dbgNpcs(), and his line by actually TALKING to him — the
//              payload the dialogue renders, not the string in the JSON.
//   enemies    enemySpecies(), the cached roster combat/index.ts spawns from,
//              including the factory each asset selected by name.
//   biomes     __dbgNature(): every shipped multiplier is exactly 1 and
//              `setArea` deletes an entry set to 1, so the biome half of the
//              migration is proven by the nature table still being DEFAULT.
//              If a single biome's numbers had moved, `isDefault` would be false.
//
// ONE FIELD HAS NO WORLD-SIDE READER: `outerRadius`. No debug hook exposes
// `TownInfo.outerRadius`, and adding one is outside what this probe owns. What
// IS checkable is that the migration did not take the decision away from the
// layout: `TownData.outerRadius` is optional and ABSENT for all three towns, so
// `outerRadiusOf(kind, radius)` in world/towns.ts still supplies it from the two
// fields asserted above — which is exactly the arrangement the pre-migration
// `SITES` table had, with the camp's written out as `CAMP_WALL_HALF * SQRT2`.
// The expected values are pinned here anyway, so that a future hook has a number
// to be checked against rather than a fresh guess.
// ===========================================================================
{
  const towns = await dbg(() => window.__dbgTowns());
  const marks = await dbg(() =>
    [...document.querySelectorAll(".bs-compass .mk")].map((el) => ({
      label: el.textContent,
      mc: el.style.getPropertyValue("--mc"),
    })),
  );
  const fromContent = await dbg(async () => {
    const { content } = await import("/src/content/index.ts");
    return content.all("town").map((a) => ({
      id: a.id.slice(a.type.length + 1),
      layout: a.data.layout,
      radius: a.data.radius,
      color: a.data.color,
      waterside: a.data.waterside,
      order: a.data.order,
      start: a.data.start,
      outerRadiusOverride: a.data.outerRadius ?? null,
    }));
  });

  const rows = [];
  for (const want of TOWNS) {
    const got = towns.towns.find((t) => t.id === want.id);
    const data = fromContent.find((t) => t.id === want.id);
    const chip = marks.find((m) => m.label === want.id.slice(0, 4).toUpperCase());
    const hex = `#${want.color.toString(16).padStart(6, "0")}`;
    rows.push({
      id: want.id,
      world: got
        ? { kind: got.kind, radius: got.radius, x: got.x, z: got.z, name: got.name }
        : null,
      content: data ?? null,
      compassChipColor: chip?.mc ?? null,
      expected: {
        kind: want.kind,
        radius: want.radius,
        x: want.x,
        z: want.z,
        name: want.name,
        color: hex,
        outerRadius: +want.outerRadius.toFixed(4),
      },
    });
    if (!got || !data) {
      check(false, `town "${want.id}" is missing from the ${got ? "content" : "world"}`);
      continue;
    }
    eq(got.kind, want.kind, `${want.id}.kind`);
    eq(got.radius, want.radius, `${want.id}.radius`);
    eq(got.x, want.x, `${want.id}.x`);
    eq(got.z, want.z, `${want.id}.z`);
    eq(got.name, want.name, `${want.id}.name`);
    eq(data.layout, want.kind, `${want.id} content layout`);
    eq(data.color, want.color, `${want.id} content colour`);
    eq(data.waterside, want.waterside, `${want.id}.waterside`);
    eq(data.order, want.order, `${want.id}.order`);
    eq(data.start, want.start, `${want.id}.start`);
    eq(chip?.mc ?? null, hex, `${want.id} colour as the compass chip drew it`);
    check(
      data.outerRadiusOverride === null,
      `${want.id} now carries an explicit outerRadius (${data.outerRadiusOverride}); ` +
        "it was the layout's answer before the migration and must stay one",
    );
  }
  const startTown = TOWNS.find((t) => t.start).id;
  check(
    fromContent.filter((t) => t.start).length === 1 &&
      fromContent.find((t) => t.start).id === startTown,
    `the start town is no longer exactly "${startTown}": ` +
      JSON.stringify(fromContent.filter((t) => t.start).map((t) => t.id)),
  );

  // ---- Gain: where he stands, and what he says when you talk to him --------
  const gain = (await dbg(() => window.__dbgNpcs())).all.find((n) => n.id === GAIN.id);
  check(!!gain, "the Encampment quest giver is missing from the world");
  let talkLine = null;
  let reachedTalkRange = false;
  if (gain) {
    eq(gain.name, GAIN.name, "gain.name");
    eq(gain.x, GAIN.x, "gain.x");
    eq(gain.y, GAIN.y, "gain.y");
    eq(gain.z, GAIN.z, "gain.z");
    eq(gain.town, GAIN.town, "gain.town");
    eq(gain.fromTownCentre, GAIN.fromTownCentre, "gain.fromTownCentre");

    // Stand next to him and press E, exactly as test-npc.mjs does. Polled on
    // the world's OWN range query rather than on a fixed wait, so a slow host
    // reads the same answer a fast one does.
    //
    // GETTING THERE IS ASSERTED SEPARATELY FROM WHAT HE SAYS. The first version
    // pressed E regardless and reported only the sentence, so a hero who was
    // never in range failed as "he said null" — a true statement about the wrong
    // thing, and the shape of a probe that sends its reader looking at the i18n
    // table for a fault in the harness.
    await consoleClosed();
    await page.evaluate((g) => window.__dbgTp(g.x + 2.0, g.z), gain);
    for (let i = 0; i < 40 && !reachedTalkRange; i++) {
      await wait(200);
      const row = (await dbg(() => window.__dbgNpcs())).all.find((n) => n.id === GAIN.id);
      reachedTalkRange = !!row?.inTalkRange;
    }
    check(
      reachedTalkRange,
      "the hero never got within talk range of Gain, so nothing below could be asked",
    );
    // THE ONE THING IN THIS FILE THAT NEEDS A RUNNING FRAME LOOP, and therefore
    // the one reason it is on probe.mjs's SOLO list. A page that is not the
    // browser's front tab reports `visibilityState: 'hidden'` and gets no
    // requestAnimationFrame at all — measured in a shared browser, the
    // background page held W for 1.2 s and travelled 0.00 units against 6.39 on
    // the front one, while its performance clock advanced normally and every
    // read-only hook went on answering. So `E` is delivered and never consumed,
    // and the failure surfaces as "he said null". Said here rather than left as
    // a puzzle for whoever batches it next.
    const visible = await dbg(() => document.visibilityState);
    check(
      visible === "visible",
      `this page is "${visible}" — a backgrounded tab runs no frames, so no key ` +
        "press can be consumed. Run this probe alone (it is in probe.mjs's SOLO list).",
    );
    for (let i = 0; i < 20 && talkLine === null; i++) {
      await page.keyboard.press("KeyE");
      await wait(250);
      talkLine = (await dbg(() => window.__dbgNpcs())).talking?.line ?? null;
    }
    eq(talkLine, GAIN.line, "the sentence Gain actually says");
    await page.keyboard.press("Escape");
    for (let i = 0; i < 20; i++) {
      await wait(150);
      if ((await dbg(() => window.__dbgNpcs())).talking === null) {
        break;
      }
    }
    const stillTalking = (await dbg(() => window.__dbgNpcs())).talking;
    check(
      stillTalking === null,
      "the conversation would not close — the console " +
        "sections below cannot run behind a modal",
    );
  }

  // ---- the enemy roster combat spawns from --------------------------------
  const specs = await dbg(async () => {
    const { enemySpecies } = await import("/src/combat/enemies.ts");
    return enemySpecies().map((s) => ({
      id: s.id,
      flying: s.flying,
      hasModel: typeof s.model === "function",
      hp: s.data.hp,
      atk: s.data.atk,
      speed: s.data.speed,
      xp: s.data.xp,
      radius: s.data.radius,
      height: s.data.height,
      aggro: s.data.aggro,
      elements: s.data.variants.map((v) => v.element),
    }));
  });
  for (const want of ENEMIES) {
    const got = specs.find((s) => s.id === want.id);
    if (!got) {
      check(false, `enemy "${want.id}" never reached the spawner`);
      continue;
    }
    check(
      got.hasModel,
      `"${want.id}" resolved no voxel builder — its model factory ` +
        "name no longer matches a registration",
    );
    for (const f of ["flying", "hp", "atk", "speed", "xp", "radius", "height", "aggro"]) {
      eq(got[f], want[f], `${want.id}.${f}`);
    }
    eq(got.elements, want.elements, `${want.id} variant elements`);
  }

  // ---- the biomes, proven by the meadow not moving ------------------------
  const nature = await dbg(() => window.__dbgNature());
  check(
    nature.isDefault === true,
    "the biome migration moved the vegetation: every shipped multiplier is 1 and " +
      `setArea deletes a 1, so the nature table must still be default — ${JSON.stringify({
        baseline: nature.baseline,
        areas: nature.areas,
      })}`,
  );
  check(
    Object.keys(nature.areas).length === 0,
    `a biome wrote an area override: ${JSON.stringify(nature.areas)}`,
  );

  results.identity = {
    towns: rows,
    gain: gain
      ? {
          world: {
            name: gain.name,
            x: gain.x,
            y: gain.y,
            z: gain.z,
            town: gain.town,
            fromTownCentre: gain.fromTownCentre,
          },
          reachedTalkRange,
          spokenLine: talkLine,
          expected: GAIN,
        }
      : null,
    enemies: specs,
    enemiesExpected: ENEMIES,
    biomes: { isDefault: nature.isDefault, areaOverrides: nature.areas },
  };
}

// ===========================================================================
// 4. THE LAZY PATH, at the console.
//
// The whole lazy design in one round trip, driven the way a developer would try
// it rather than through a hook: `/content load example-quest` fetches that
// package's own chunk, `example-quest` appears under a `debug` lease with its
// `requires: ["core"]` recorded, its quest reaches the registry, and its
// CROSS-PACKAGE references resolve — `npc:gain` and `town:encampment` both live
// in core, and a graph that reported those as dangling would be a graph that
// could never carry a second package. Then `/content release example-quest` and
// the definitions are gone while `core` is untouched.
//
// The quest COUNT is the campaign's before and after, which is the assertion
// that makes "nothing extra is loaded at boot" (section 1) and "a package can be
// dropped" one fact rather than two — a release that took Act 1 with it, or one
// that left `example-quest` behind, both land on the same number.
// ===========================================================================
{
  const before = await dbg(() => window.__dbgContent());
  check(
    before.assets.quest === ACT1_QUESTS.length,
    `the boot holds ${before.assets.quest} quests, not the campaign's ${ACT1_QUESTS.length}`,
  );
  check(
    !before.packages.some((p) => p.id === "example-quest"),
    "example-quest is loaded at boot — it is the package that must not be",
  );

  const loadOut = await cmd("/content load example-quest", 2);
  const after = await dbg(() => window.__dbgContent());
  const pkg = after.packages.find((p) => p.id === "example-quest") ?? null;
  const graph = await dbg(async () => {
    const { content } = await import("/src/content/index.ts");
    const q = content.get("quest:encampment/first-steps");
    if (!q) {
      return null;
    }
    return {
      id: q.id,
      pkg: q.pkg,
      source: q.source,
      refs: [...q.refs].toSorted(),
      unresolved: [...q.refs].filter((r) => !content.has(r)).toSorted(),
      giver: q.data.giver,
      location: q.data.location,
    };
  });

  const releaseOut = await cmd("/content release example-quest");
  const end = await dbg(() => window.__dbgContent());
  const gone = await dbg(async () => {
    const { content } = await import("/src/content/index.ts");
    return content.get("quest:encampment/first-steps") === undefined;
  });

  results.lazyPath = {
    before: { quest: before.assets.quest, packages: before.packages.map((p) => p.id) },
    loadReply: loadOut.split("\n").pop(),
    package: pkg,
    quest: graph,
    releaseReply: releaseOut.split("\n").pop(),
    after: { quest: end.assets.quest, packages: end.packages.map((p) => p.id) },
  };

  check(
    /loaded "example-quest": 1 assets/.test(loadOut),
    `/content load did not report a load: ${JSON.stringify(loadOut)}`,
  );
  check(pkg !== null, "example-quest is not in the package list after loading it");
  if (pkg) {
    eq(pkg.leases, ["debug"], "example-quest leases (a console load is never `boot`)");
    eq(pkg.requires, ["core"], "example-quest dependencies");
    check(pkg.source === "bundled:example-quest", `example-quest came from "${pkg.source}"`);
  }
  check(
    after.assets.quest === ACT1_QUESTS.length + 1,
    `quest count after the load is ${after.assets.quest}, not ${ACT1_QUESTS.length + 1}`,
  );
  check(graph !== null, "quest:encampment/first-steps is not in the registry after the load");
  if (graph) {
    eq(graph.refs, ["npc:gain", "town:encampment"], "the quest's cross-package references");
    eq(graph.unresolved, [], "cross-package references the graph could NOT resolve");
    eq(graph.pkg, "example-quest", "the package the quest is attributed to");
  }
  check(
    /released "example-quest"/.test(releaseOut),
    `/content release did not report a release: ${JSON.stringify(releaseOut)}`,
  );
  check(gone === true, "the quest definition survived the release");
  eq(
    end.packages.map((p) => p.id),
    BOOT_PACKAGES,
    "packages after the release",
  );
  check(
    end.assets.quest === ACT1_QUESTS.length,
    `quest count after the release is ${end.assets.quest}, not ${ACT1_QUESTS.length}`,
  );
  check(
    end.diagnostics.length === 0,
    `a load/release round trip left findings behind: ${JSON.stringify(end.diagnostics)}`,
  );
}

// ===========================================================================
// 5. UNLOADING TAKES THE DEFINITIONS AND LEAVES THE FACTS.
//
// Spec §12.3's three-way distinction, and the only place it is checkable: a
// released package's DEFINITIONS go, its instances are destroyed, and the
// player's persistent STATE stays exactly where it was. That is what makes a
// quest pack droppable at all — a save records `quest:x` is active and
// `met-gain` is set, and those facts have to survive a zone whose pack was
// collected, or a player who walked out of a zone would lose the quest they were
// carrying.
//
// The quest is STARTED through the runtime rather than by hand: `content.run`
// dispatches the asset's own `onStart` actions, so the flag written here is the
// flag the content asked for (`flag.set first-steps-started`), not one this
// probe invented.
// ===========================================================================
{
  await cmd("/content load example-quest", 2);
  const started = await dbg(async () => {
    const { content } = await import("/src/content/index.ts");
    const q = content.get("quest:encampment/first-steps");
    if (!q) {
      return null;
    }
    content.run(q.data.onStart); // the asset's own actions
    content.state.setQuestStatus(q.id, "active");
    content.state.setProgress(q.id, "talk-to-gain", 1);
    return { state: content.state.toJSON(), status: content.state.questStatus(q.id) };
  });
  check(started !== null, "example-quest did not load for the state test");

  const releaseOut = await cmd("/content release example-quest");
  const afterState = await dbg(async () => {
    const { content } = await import("/src/content/index.ts");
    const id = "quest:encampment/first-steps";
    return {
      state: content.state.toJSON(),
      status: content.state.questStatus(id),
      flag: content.state.flag("first-steps-started"),
      definitionGone: content.get(id) === undefined,
      packages: content.packages.map((p) => p.id),
    };
  });

  results.stateUnload = {
    beforeRelease: started?.state ?? null,
    afterRelease: afterState.state,
    questStatusAfterRelease: afterState.status,
    flagAfterRelease: afterState.flag,
    definitionGone: afterState.definitionGone,
    packages: afterState.packages,
    releaseReply: releaseOut.split("\n").pop(),
  };

  check(
    afterState.definitionGone,
    "the DEFINITION survived the release — nothing was actually unloaded",
  );
  check(
    afterState.status === "active",
    `the quest's status was lost with its definition: "${afterState.status}"`,
  );
  check(afterState.flag === true, "the flag the quest set was lost with its definition");
  check(
    same(started?.state, afterState.state),
    `unloading a package changed the save payload:\n  before ${JSON.stringify(
      started?.state,
    )}\n  after  ${JSON.stringify(afterState.state)}`,
  );
  eq(afterState.packages, BOOT_PACKAGES, "packages after the state test");

  // Put the runtime back the way section 1 found it, so nothing below inherits
  // a session's worth of facts.
  await dbg(async () => {
    const { content } = await import("/src/content/index.ts");
    content.state.reset();
  });
}

// ===========================================================================
// 6. A BROKEN ASSET IS REPORTED, NOT SWALLOWED.
//
// Everything short of fatal degrades with a placeholder, which is the design —
// and which is exactly why the diagnostic has to be asserted on. A migration
// that silently dropped a field would leave a world that boots.
//
// It is run against a SECOND runtime (`createContentRuntime`, which the module's
// own header says is the way to make an isolated graph) fed by a provider
// written here. The provider is the only substituted piece, and it is the piece
// under nobody's test: the parser, the loader, the registry, the type
// definitions and the cross-asset validator are all the shipped ones. Two
// findings at two depths, because they fail at two:
//
//   bad-field    `"radius": "wide"` — caught by the town type's own parser as
//                the asset is read.
//   missing-ref  an npc whose `town` names something nothing defines — caught by
//                the cross-asset pass, which is the only thing that can see it.
//
// The last assertion is the one that keeps this section honest: the GAME's
// runtime must be untouched by any of it.
// ===========================================================================
{
  const bad = await dbg(async () => {
    const { createContentRuntime } = await import("/src/content/index.ts");
    const PKG = {
      id: "probe-bad",
      version: "0.0.1",
      assets: [
        {
          id: "town:probe-broken",
          schema: 1,
          name: { text: { en: "Broken" } },
          data: {
            sign: { text: { en: "x" } },
            layout: "camp",
            radius: "wide", // <- not a number
            color: "#ffffff",
            waterside: false,
            order: 9,
            start: false,
          },
        },
        {
          id: "npc:probe-orphan",
          schema: 1,
          name: { text: { en: "Orphan" } },
          data: {
            town: "town:nowhere", // <- nothing defines it
            body: "gain",
            homeOffset: 0,
            acrossFocus: true,
            talk: [{ line: { text: { en: "hi" } } }],
          },
        },
      ],
    };
    const provider = {
      name: "probe",
      priority: 99,
      writable: false,
      list: async () => ["probe-bad"],
      read: async (pkg) => (pkg === "probe-bad" ? PKG : null),
    };
    const rt = createContentRuntime({ providers: [provider] });
    const load = await rt.load("probe-bad", "editor");
    const validation = rt.validate("dev", []);
    // The RAW diagnostics: `shape` lives in this file's module scope and a
    // page.evaluate body is compiled in the page, where it does not exist.
    return { load: load.diagnostics, validation };
  });
  bad.load = bad.load.map(shape);
  bad.validation = bad.validation.map(shape);
  const host = await dbg(() => window.__dbgContent());
  const found = [...bad.load, ...bad.validation];
  const has = (code, assetId, field) =>
    found.some(
      (d) =>
        d.code === code &&
        d.assetId === assetId &&
        (field === undefined || d.field === field) &&
        (d.severity === "error" || d.severity === "fatal"),
    );

  results.validation = {
    loadDiagnostics: bad.load,
    validationDiagnostics: bad.validation,
    hostRuntimeUntouched: {
      packages: host.packages.map((p) => p.id),
      diagnostics: host.diagnostics.length,
      state: host.state,
    },
  };

  check(
    has("bad-field", "town:probe-broken", "data.radius"),
    "a town with a string radius produced no `bad-field` on data.radius: " + JSON.stringify(found),
  );
  check(
    has("missing-ref", "npc:probe-orphan"),
    "an npc pointing at a town nothing defines produced no `missing-ref`: " + JSON.stringify(found),
  );
  eq(
    host.packages.map((p) => p.id),
    BOOT_PACKAGES,
    "the game's own runtime after the broken-package test",
  );
  check(
    host.diagnostics.length === 0,
    `the broken package leaked findings into the game's runtime: ${JSON.stringify(
      host.diagnostics,
    )}`,
  );
  check(
    same(host.state, { v: 1 }),
    `the game's content state did not come back clean: ${JSON.stringify(host.state)}`,
  );
}

console.log(JSON.stringify(results, null, 2));
if (fails.length) {
  console.error(`\nFAIL (${fails.length})`);
  for (const f of fails) {
    console.error(`  - ${f}`);
  }
}
await browser.close();
process.exit(fails.length ? 1 : 0);
