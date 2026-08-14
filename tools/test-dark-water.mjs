// ACT 2, QUEST 2 — DARK WATER (issue #153): the act's mount tutorial, and the
// mechanic it teaches. The channels refuse the hero on foot; bonding the
// Aquaxol unlocks the water mount; and from then on TOUCHING the dark water
// auto-mounts the water beast — an engine mechanic gated on the story flag,
// not a quest step, so it outlives the quest and the act.
//
// Usage: bun tools/test-dark-water.mjs      (dev server must be up)
//
// Four claims, and the pair in 1/4 is the point:
//
//   1. BEFORE the quest, the dark water refuses him ON FOOT — measured: a held
//      W into the channel leaves him short of the deep column, unmounted.
//   2. THE QUEST RUNS: Gain offers it after Salt and Rope, a staged Aquaxol is
//      bonded with a forced orb, and the turn-in completes it — mount-water
//      and dark-water-open set.
//   3. THE SHALLOWS ARE A HABITAT: Saltrest's shore ring holds walkable damp
//      band for the Aquaxol to spawn on (the wild rolls are spawn-tables'
//      subject; the ground being there is this quest's).
//   4. AFTER the quest, the same held W auto-mounts the water beast and he
//      CROSSES the line that refused him — measured on position and the
//      mount's own state, not on a flag read.
//
// Exits non-zero on failure.
import { launchBrowser, newPage, wait } from "./browser.mjs";
import { BASE as HOST, NO_WARMUP } from "./target.mjs";

const URL = `${HOST}/?menu=0&fs=0&vol=0&${NO_WARMUP}`;

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
await page.waitForFunction(() => window.__dbgBoot?.().playing && window.__dbgAdvance, {
  timeout: 90000,
});
await wait(400);

const dbg = (fn, ...args) => page.evaluate(fn, ...args);
const adv = (s) => dbg((n) => window.__dbgAdvance(n), s);
const tp = (x, z) => dbg((p) => window.__dbgTp(p.x, p.z), { x, z });
const pos = () => dbg(() => window.__dbgPlayerPos());
const mountState = () => dbg(() => window.__dbgMount());
const state = () =>
  dbg(async () => {
    const { content } = await import("/src/content/index.ts");
    const q = "quest:sea/dark-water";
    return {
      status: content.state.questStatus(q),
      tame: content.state.progress(q, "tame-aquaxol"),
      mountWater: content.state.flag("mount-water"),
      darkOpen: content.state.flag("dark-water-open"),
    };
  });

async function talkTo(id) {
  const who = (await dbg(() => window.__dbgNpcs())).all.find((n) => n.id === id);
  if (!who) {
    return null;
  }
  await dbg((n) => window.__dbgTp(n.x + 2, n.z), who);
  await wait(300);
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press("KeyE");
    await wait(200);
    const talking = (await dbg(() => window.__dbgNpcs())).talking;
    if (talking?.id === id) {
      return talking.line;
    }
  }
  return null;
}

// ---------- stage: the campaign up to this quest's doorstep ------------------
await dbg(async () => {
  const { content } = await import("/src/content/index.ts");
  // Through the real state store, so each completion replays its onComplete —
  // sea-revealed, has-boat, the shards — exactly as the turn-ins would.
  content.state.setQuestStatus("quest:land/the-bellwether", "completed");
  content.state.setQuestStatus("quest:sea/salt-and-rope", "completed");
});
await wait(300);

const saltrest = (await dbg(() => window.__dbgTowns().towns)).find((t) => t.id === "saltrest");
check(!!saltrest, "town:saltrest is not in the world");
await tp(saltrest.x, saltrest.z);
await page.waitForFunction(() => !window.__dbgZone().streaming, { timeout: 60000 }).catch(() => {});
await wait(400);

// ---------- geometry: the channel off the quay -------------------------------
// March from the town centre along the quay bearing to the first DEEP column;
// the launch point is the last dry ground before it.
const geom = await dbg((t) => {
  const ux = Math.sin((t.gateBearingDeg * Math.PI) / 180);
  const uz = Math.cos((t.gateBearingDeg * Math.PI) / 180);
  // OFF the pier's own line: #228 built a walkable deck straight down the quay
  // bearing, and a deck is FOR walking over water — the refusal is a property
  // of the bare channel, so the march runs a lane beside the harbour works.
  const ox = Math.cos((t.gateBearingDeg * Math.PI) / 180) * -9;
  const oz = -Math.sin((t.gateBearingDeg * Math.PI) / 180) * -9;
  let shore = null;
  let deep = null;
  for (let d = t.radius; d < 220; d += 2) {
    const x = t.x + ox + ux * d;
    const z = t.z + oz + uz * d;
    const w = window.__dbgWorld(x, z);
    if (!w.water && deep === null) {
      shore = { x, z, d };
    }
    if (w.deep) {
      deep = { x, z, d };
      break;
    }
  }
  // The damp band the Aquaxol spawns on: stepped shore columns around the island.
  let band = 0;
  for (let k = 0; k < 48; k++) {
    const a = (k / 48) * Math.PI * 2;
    for (const r of [t.radius * 1.6, t.radius * 2.2, t.radius * 3]) {
      const g = window.__dbgSurfaceY(t.x + Math.cos(a) * r, t.z + Math.sin(a) * r).ground;
      if (g === 8) {
        band++;
      }
    }
  }
  return { shore, deep, band, heading: Math.atan2(ux, uz) };
}, saltrest);
results.geom = geom;
check(geom.deep !== null, "no dark water within 220 of Saltrest's quay — the act's channel is missing");
check(geom.band >= 6, `only ${geom.band} damp-band columns ring the island — nowhere for an Aquaxol to stand`);

/** Aim at the channel, hold W for `holdS` simulated seconds, report the far end. */
async function driveIntoChannel(holdS) {
  await dbg(
    ([x, z, y]) => {
      window.__dbgTp(x, z);
      window.__dbgAim(y);
    },
    [geom.shore.x, geom.shore.z, geom.heading],
  );
  await adv(0.9);
  await dbg(
    ([x, z, y]) => {
      window.__dbgTp(x, z);
      window.__dbgAim(y);
    },
    [geom.shore.x, geom.shore.z, geom.heading],
  );
  await adv(0.4);
  await page.keyboard.down("KeyW");
  await adv(holdS);
  await page.keyboard.up("KeyW");
  await adv(0.25);
  const p = await pos();
  const w = await dbg(([x, z]) => window.__dbgWorld(x, z), [p.x, p.z]);
  const m = await mountState();
  const travelled = (p.x - geom.shore.x) * Math.sin(geom.heading) + (p.z - geom.shore.z) * Math.cos(geom.heading);
  return { travelled: +travelled.toFixed(2), overDeep: w.deep, mounted: m.mounted, beast: m.beast };
}

// ---------- 1. before: the channel refuses him on foot -----------------------
{
  const run = await driveIntoChannel(6);
  results.before = run;
  const shortOf = geom.deep.d - geom.shore.d;
  check(run.mounted === false, "something mounted the hero before the quest granted a water beast");
  check(
    !run.overDeep && run.travelled < shortOf + 4,
    `on foot he reached ${run.travelled} along the channel (deep starts at ${shortOf}) — the refusal did not hold`,
  );
}

// ---------- 2. the quest, end to end -----------------------------------------
{
  const offer = await talkTo("gain/saltrest");
  const started = await state();
  results.offer = { line: offer, status: started.status };
  check(offer !== null, "Gain has no Dark Water offer");
  check(started.status === "active", `the offer left the quest "${started.status}"`);
  await page.keyboard.press("Escape");
  await wait(250);

  // A staged Aquaxol beside the hero, three orbs, one forced bond — the wild
  // roll is spawn-tables' subject; the quest's own trigger is what is under test.
  await dbg(() => window.__dbgGive("orb-tame", 3));
  await dbg(() => window.__dbgSpawn("enemies", "wild-aquaxol"));
  await wait(300);
  const target = await dbg(
    () => window.__dbgBodies().enemies.find((e) => e.species === "wild-aquaxol") ?? null,
  );
  results.staged = target;
  check(target !== null, "the spawner produced no wild-aquaxol");
  if (target) {
    await tp(target.x + 3, target.z + 3);
    await wait(300);
    results.throwSaid = await dbg(() => window.__dbgThrowOrb("wild-aquaxol", true));
    // THE ORB HAS TO ARRIVE (tools/test-taming.mjs): waited FOR, then waited
    // OUT — `!bonding` alone passes instantly for a throw still in flight.
    let landed = false;
    for (let i = 0; i < 40 && !landed; i++) {
      await adv(0.1);
      landed = (await dbg(() => window.__dbgTaming())).bonding;
    }
    check(landed, `the orb never reached the Aquaxol (${results.throwSaid?.dist} units out)`);
    for (let i = 0; i < 80 && (await dbg(() => window.__dbgTaming())).bonding; i++) {
      await adv(0.1);
    }
    await wait(300);
  }
  const tamed = await state();
  results.tamed = tamed;
  check(tamed.tame >= 1, "the bond did not advance tame-aquaxol");

  const done = await talkTo("gain/saltrest");
  await page.keyboard.press("Escape");
  await wait(250);
  const ended = await state();
  results.done = { line: done, ...ended };
  check(ended.status === "completed", `the turn-in left the quest "${ended.status}"`);
  check(ended.mountWater === true, "mount-water was not set");
  check(ended.darkOpen === true, "dark-water-open was not set");
}

// ---------- 4. after: the same walk mounts him and crosses -------------------
{
  const run = await driveIntoChannel(8);
  results.after = run;
  const shortOf = geom.deep.d - geom.shore.d;
  check(run.mounted === true, "touching the dark water did not mount the water beast");
  check(
    run.beast === "aquaxol",
    `the auto-mount chose "${run.beast}", not the aquaxol the quest bonded`,
  );
  check(
    run.travelled > shortOf + 4,
    `mounted he reached only ${run.travelled} (deep starts at ${shortOf}) — the crossing is still refused`,
  );
}

console.log(JSON.stringify({ ...results, failures: fails, pass: fails.length === 0 }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
