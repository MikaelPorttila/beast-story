// ACT 2, QUEST 4 — THE ROOKERY (issue #155): Gullspire, the third island; the
// turned flock; Corwin Vane got down alive. The escort is the REAL walk since
// issue #234 (the follower mechanic; tools/test-escort.mjs owns its edges), so
// what this drives is the quest end to end: the staged flock, the bond that
// calms it, the descent, the wreck's salvage, and the seam flags Act 3 reads.
//
// Usage: bun tools/test-rookery.mjs      (dev server must be up)
//
// Five claims:
//
//   1. GULLSPIRE STANDS ON ITS OWN ISLAND, third down the lobe, apart from both
//      sister settlements.
//   2. THE QUEST OPENS OFF DARK WATER ALONE — and the OTHER fork arm, the
//      drowned market, is untouched from first press to last: the fork's
//      independence in this direction, asserted at the end.
//   3. THE FLOCK IS STAGED AND CALMED: three Galebirds hold the wreck, one
//      forced bond marks calm-the-flock, and the stage stops restocking — a
//      bond empties the objective, not the sky.
//   4. THE WALK DOWN IS WALKED (issue #234): Vane's post-calm line starts the
//      escort, escort-vane ticks when the FOLLOWER reaches the wreck, and the
//      wreck gives up the vane component.
//   5. THE TURN-IN CLOSES IT: completed, component-vane AND knows-the-sky set
//      (the flag Act 3's framing tests), Gullspire discovered, 100 paid.
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
const state = () =>
  dbg(async () => {
    const { content } = await import("/src/content/index.ts");
    const q = "quest:sea/the-rookery";
    return {
      status: content.state.questStatus(q),
      calm: content.state.progress(q, "calm-the-flock"),
      escort: content.state.progress(q, "escort-vane"),
      vane: content.state.progress(q, "recover-component"),
      flagVane: content.state.flag("component-vane"),
      knowsSky: content.state.flag("knows-the-sky"),
      discovered: content.state.discovered("town:gullspire"),
      market: content.state.questStatus("quest:sea/the-drowned-market"),
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

// ---------- stage the campaign to the fork -----------------------------------
await dbg(async () => {
  const { content } = await import("/src/content/index.ts");
  content.state.setQuestStatus("quest:land/the-bellwether", "completed");
  content.state.setQuestStatus("quest:sea/salt-and-rope", "completed");
  content.state.setQuestStatus("quest:sea/dark-water", "completed");
});
await wait(300);

// ---------- 1. Gullspire on its own island -----------------------------------
let gullspire;
{
  const towns = await dbg(() => window.__dbgTowns().towns);
  gullspire = towns.find((t) => t.id === "gullspire");
  results.gullspire = gullspire ?? null;
  check(!!gullspire, "town:gullspire is not in the world registry");
  for (const other of ["saltrest", "kelphold"]) {
    const t = towns.find((x) => x.id === other);
    if (gullspire && t) {
      const apart = Math.hypot(gullspire.x - t.x, gullspire.z - t.z);
      check(apart > 250, `Gullspire stands ${apart.toFixed(0)} from ${other} — not its own island`);
    }
  }
}

await dbg((t) => window.__dbgTp(t.x, t.z), gullspire);
await page.waitForFunction(() => !window.__dbgZone().streaming, { timeout: 60000 }).catch(() => {});
await wait(400);

// ---------- 2. the offer -----------------------------------------------------
{
  const offer = await talkTo("sky-pilot/gullspire");
  const started = await state();
  results.offer = { line: offer, status: started.status };
  check(offer !== null, "Corwin Vane is not on Gullspire");
  check(started.status === "active", `the offer left the quest "${started.status}"`);
  await page.keyboard.press("Escape");
  await wait(250);
}

// ---------- 3. the flock, staged and calmed ----------------------------------
{
  const wreck = await dbg(() => window.__dbgQuestSites().vaneWreck);
  check(!!wreck, "the wreck has no site");
  await dbg((p) => window.__dbgTp(p.x + 3, p.z + 3), wreck);
  // Polled: a fresh spawn is not `targetable` for its first beats, and the
  // stage itself only runs on its own cadence.
  let flock = 0;
  for (let i = 0; i < 20 && flock < 3; i++) {
    await adv(0.5);
    flock = await dbg(
      () =>
        window.__dbgBodies().enemies.filter((e) => e.targetable && e.species === "wild-galebird")
          .length,
    );
  }
  results.flock = { staged: flock };
  check(flock === 3, `${flock} Galebirds hold the wreck, want 3`);

  await dbg(() => window.__dbgGive("orb-tame", 3));
  results.throwSaid = await dbg(() => window.__dbgThrowOrb("wild-galebird", true));
  let landed = false;
  for (let i = 0; i < 40 && !landed; i++) {
    await adv(0.1);
    landed = (await dbg(() => window.__dbgTaming())).bonding;
  }
  check(landed, `the orb never reached a Galebird (${results.throwSaid?.dist} units out)`);
  for (let i = 0; i < 80 && (await dbg(() => window.__dbgTaming())).bonding; i++) {
    await adv(0.1);
  }
  await wait(300);
  const calmed = await state();
  results.calmed = { calm: calmed.calm };
  check(calmed.calm >= 1, "the bond did not mark calm-the-flock");

  // A bond empties the OBJECTIVE, not the sky: the stage must stop restocking.
  await adv(4);
  const after = await dbg(
    () => window.__dbgBodies().enemies.filter((e) => e.targetable && e.species === "wild-galebird").length,
  );
  results.flock.afterCalm = after;
  check(after <= 2, `the flock restocked to ${after} after the calm — the stage kept spawning`);
}

// ---------- 4. the walk down, and the wreck's salvage ------------------------
{
  // THE REAL DESCENT (issue #234): the post-calm line puts Vane into follower
  // mode, and escort-vane ticks when HE reaches the wreck, not when the line is
  // spoken. Led in two hops under the leash so the walk is walked.
  const down = await talkTo("sky-pilot/gullspire");
  results.down = { line: down };
  await page.keyboard.press("Escape");
  await wait(250);
  const following = (await dbg(() => window.__dbgNpcs())).all.find(
    (n) => n.id === "sky-pilot/gullspire",
  );
  check(following?.escorting === true, "Vane's post-calm line did not start the escort");

  const wreck = await dbg(() => window.__dbgQuestSites().vaneWreck);
  await dbg((p) => window.__dbgTp((p.vx + p.wx) / 2, (p.vz + p.wz) / 2), {
    vx: following.x,
    vz: following.z,
    wx: wreck.x,
    wz: wreck.z,
  });
  await adv(4);
  await dbg((p) => window.__dbgTp(p.x, p.z), wreck);
  let mid = await state();
  for (let i = 0; i < 20 && mid.escort < 1; i++) {
    await adv(0.5);
    mid = await state();
  }
  check(mid.escort >= 1, "Vane was led to the wreck and escort-vane never ticked");

  await adv(1.5);
  const got = await state();
  results.salvaged = { vane: got.vane };
  check(got.vane >= 1, "the vane was never claimed at the wreck");
}

// ---------- 5. the turn-in ---------------------------------------------------
{
  const before = await dbg(() => window.__dbgZone().shards);
  const done = await talkTo("sky-pilot/gullspire");
  await page.keyboard.press("Escape");
  await wait(250);
  const ended = await state();
  const paid = (await dbg(() => window.__dbgZone().shards)) - before;
  results.done = { line: done, ...ended, paid };
  check(ended.status === "completed", `the turn-in left the quest "${ended.status}"`);
  check(ended.flagVane === true, "component-vane was not set");
  check(ended.knowsSky === true, "knows-the-sky was not set — Act 3 has no framing flag");
  check(ended.discovered === true, "town:gullspire was not discovered");
  check(paid === 100, `the reward paid ${paid} shards, not the promised 100`);
  // The fork's other arm, untouched from first press to last (issue #144 DoD half).
  check(
    ended.market === "unknown",
    `the drowned market read "${ended.market}" — this quest must not touch the other arm`,
  );
}

console.log(JSON.stringify({ ...results, failures: fails, pass: fails.length === 0 }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
