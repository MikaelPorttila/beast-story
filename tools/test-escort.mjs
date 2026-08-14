// THE ESCORT MECHANIC (issue #234): an NPC follower a quest selects by name.
// The engine half is `Npcs.startEscort` (world/npc.ts) — leave the placement,
// follow the hero, leash-teleport when left behind, re-station at the
// destination — and the content half is the `escort.start` action plus the
// `escort` objective trigger, exercised here through the Rookery's real rows.
//
// Usage: bun tools/test-escort.mjs      (dev server must be up)
//
// Five claims:
//
//   1. THE TALK STARTS THE WALK: Vane's post-calm row runs `escort.start`, he
//      enters follower mode, and the target ring marks HIM, not a spot.
//   2. HE FOLLOWS: lead the hero off and the follower leaves his placement and
//      closes to conversation distance — both halves, moved AND arrived.
//   3. THE LEASH IS THE FAILURE MODEL: a follower left past TELEPORT range
//      beams to the hero in one slice. He cannot die (#155), so he cannot be
//      lost either.
//   4. ARRIVAL COMPLETES: walk him to the wreck and escort-vane ticks, the
//      follower re-stations there, and the ring comes off.
//   5. THE ROW CLOSES BEHIND IT: talking again cannot restart the walk — the
//      dialogue gate reads the objective it advanced, so a later row answers.
//
// Exits non-zero on failure.
import { launchBrowser, newPage, wait } from "./browser.mjs";
import { BASE as HOST, NO_WARMUP } from "./target.mjs";

const URL = `${HOST}/?menu=0&fs=0&vol=0&${NO_WARMUP}`;
const QUEST = "quest:sea/the-rookery";
const VANE = "sky-pilot/gullspire";

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
const vane = async () => (await dbg(() => window.__dbgNpcs())).all.find((n) => n.id === VANE);
const escortProgress = () =>
  dbg(async (q) => {
    const { content } = await import("/src/content/index.ts");
    return content.state.progress(q, "escort-vane");
  }, QUEST);
const vaneMark = async () =>
  (await dbg(() => window.__dbgQuestMarks())).marked.npcs.find((n) => n.id === VANE) ?? null;

// ---------- stage: quest active, flock already calmed ------------------------
await dbg(async (q) => {
  const { content } = await import("/src/content/index.ts");
  content.state.setQuestStatus("quest:land/the-bellwether", "completed");
  content.state.setQuestStatus("quest:sea/salt-and-rope", "completed");
  content.state.setQuestStatus("quest:sea/dark-water", "completed");
  content.state.setQuestStatus(q, "active");
  content.state.setProgress(q, "calm-the-flock", 1);
}, QUEST);
await wait(300);

const who = await vane();
check(!!who, "Corwin Vane is not in the world");
const wreck = await dbg(() => window.__dbgQuestSites().vaneWreck);
check(!!wreck, "the wreck has no site");
if (!who || !wreck) {
  console.log(JSON.stringify({ results, failures: fails, pass: false }, null, 2));
  await browser.close();
  process.exit(1);
}

await dbg((n) => window.__dbgTp(n.x + 2, n.z), who);
await page.waitForFunction(() => !window.__dbgZone().streaming, { timeout: 60000 }).catch(() => {});
await wait(400);

// ---------- 1. the talk starts the walk --------------------------------------
{
  let line = null;
  for (let i = 0; i < 20 && line === null; i++) {
    await page.keyboard.press("KeyE");
    await wait(200);
    line = (await dbg(() => window.__dbgNpcs())).talking?.line ?? null;
  }
  await page.keyboard.press("Escape");
  await wait(250);
  const after = await vane();
  const mark = await vaneMark();
  results.start = { line, escorting: after.escorting, mark };
  check(line !== null, "Vane never opened a conversation");
  check(after.escorting === true, "the post-calm row did not put Vane into follower mode");
  check(mark?.kind === "target", `the escorted NPC wears "${mark?.kind}", want the target ring`);
}

// ---------- 2. he follows ----------------------------------------------------
{
  const before = await vane();
  // A stop short of the wreck, well inside the leash, so what closes the gap is
  // the WALK and not the teleport rule tested next.
  const mx = before.x + (wreck.x - before.x) * 0.45;
  const mz = before.z + (wreck.z - before.z) * 0.45;
  await dbg((p) => window.__dbgTp(p.x, p.z), { x: mx, z: mz });
  await adv(4);
  const after = await vane();
  const moved = Math.hypot(after.x - before.x, after.z - before.z);
  results.follow = { moved: +moved.toFixed(2), fromPlayer: after.fromPlayer };
  check(moved > 3, `the follower moved ${moved.toFixed(2)} units — he did not leave his placement`);
  check(
    after.fromPlayer < 6,
    `the follower stopped ${after.fromPlayer} from the hero, want conversation distance`,
  );
}

// ---------- 3. the leash -----------------------------------------------------
{
  const at = await vane();
  // Straight past TELEPORT range (40) in one jump; one slice later he is behind
  // the hero, because a follower cannot be lost.
  const far = { x: at.x + 60, z: at.z };
  await dbg((p) => window.__dbgTp(p.x, p.z), far);
  await adv(0.1);
  const after = await vane();
  results.leash = { fromPlayer: after.fromPlayer, escorting: after.escorting };
  check(
    after.fromPlayer < 6,
    `left 60 behind, the follower is still ${after.fromPlayer} out — the leash did not beam him`,
  );
  check(after.escorting === true, "the teleport ended the escort — it must only move him");
}

// ---------- 4. arrival completes ---------------------------------------------
{
  // Two hops under the leash, so the descent to the wreck is WALKED.
  const near = { x: wreck.x + 25, z: wreck.z };
  await dbg((p) => window.__dbgTp(p.x, p.z), near);
  await adv(5);
  await dbg((p) => window.__dbgTp(p.x, p.z), wreck);
  let progress = 0;
  for (let i = 0; i < 24 && progress < 1; i++) {
    await adv(0.5);
    progress = await escortProgress();
  }
  const after = await vane();
  const atWreck = Math.hypot(after.x - wreck.x, after.z - wreck.z);
  const mark = await vaneMark();
  results.arrival = {
    progress,
    escorting: after.escorting,
    fromWreck: +atWreck.toFixed(2),
    mark,
  };
  check(progress >= 1, "the walk reached the wreck and escort-vane never ticked");
  check(after.escorting === false, "the objective ticked but Vane is still a follower");
  check(atWreck < 9, `Vane re-stationed ${atWreck.toFixed(2)} from the wreck, want under 9`);
  check(mark?.kind !== "target", "the target ring is still on Vane after the walk");
}

// ---------- 5. the row closes behind it --------------------------------------
{
  // Back to conversation distance: the station is a radius, not the hero's feet.
  const at = await vane();
  await dbg((n) => window.__dbgTp(n.x + 2, n.z), at);
  await wait(250);
  let line = null;
  for (let i = 0; i < 20 && line === null; i++) {
    await page.keyboard.press("KeyE");
    await wait(200);
    line = (await dbg(() => window.__dbgNpcs())).talking?.line ?? null;
  }
  await page.keyboard.press("Escape");
  await wait(250);
  const progress = await escortProgress();
  const after = await vane();
  results.reTalk = { line, progress, escorting: after.escorting };
  check(line !== null, "Vane fell silent after the escort");
  check(
    after.escorting === false && progress === 1,
    "talking again restarted a completed escort — the dialogue gate is not reading the objective",
  );
}

console.log(JSON.stringify({ ...results, failures: fails, pass: fails.length === 0 }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
