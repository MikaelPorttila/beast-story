// Verifies the NPC talk test (src/world/npc.ts): you have to be NEXT TO someone
// to be offered a conversation with them, in all three axes.
//
// Usage: bun tools/test-npc.mjs        (dev server must be up)
//
// This exists because the test was two-dimensional. `NpcField.nearest` took
// (x, z) and nothing else, so a hero flying over the Encampment was offered
// "Press E — Talk to Deckard Gains Armstrong" for the whole crossing — measured
// at dy 36.92, still prompting, on a galebird climbing straight up out of camp
// (issue #25). Nothing in tools/ could see it: every other probe drives a hero
// who is standing on the ground, where the missing axis is always zero.
//
// It also guards the OPENING POSE, which belongs here rather than in a probe of
// its own for the reason the pose itself is derived rather than authored: where
// a new session begins is "beside the start town's greeter, facing his way",
// and this is the file that already knows who that is. It runs FIRST, before
// anything teleports the hero.
//
// The shape of the run is a PAIR, the way test-menu.mjs holds W twice. The same
// hero at the same xz either side of one change of altitude: on the ground the
// prompt must be up and E must open a conversation, and in the air the prompt
// must be gone, E must do nothing, and a conversation begun on the ground must
// have ended by itself. A one-sided assertion cannot tell "the height check
// works" from "the prompt is broken everywhere".
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
await wait(5000);
await page.focus('canvas').catch(() => {});

const npcs = () => page.evaluate(() => window.__dbgNpcs?.());
const pos = () => page.evaluate(() => window.__dbgPlayerPos?.());
/** The hint pill's text, or null when it is not showing. */
const hint = () => page.evaluate(() => {
  const el = document.querySelector('.bs-hint');
  if (!el || !el.classList.contains('show')) return null;
  return el.textContent.trim();
});
const talking = async () => (await npcs()).talking?.id ?? null;
const gainRow = async () => (await npcs()).all.find((n) => n.id === 'gain');

/** Type one line at the dev console. The only way to stage a mount. */
async function cmd(line) {
  await page.keyboard.press('Backquote');
  await page.waitForSelector('.bs-console-input', { visible: true });
  await page.type('.bs-console-input', line);
  await page.keyboard.press('Enter');
  await wait(400);
  await page.keyboard.press('Backquote');
  await wait(400);
}

const results = {};
const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); };

const gain = await gainRow();
if (!gain) {
  console.error('no NPC with id "gain" — the Encampment quest giver is missing');
  await browser.close();
  process.exit(1);
}

// ---------- the OPENING POSE, and it has to be read first ----------
//
// FIRST, because every other section in this file teleports the hero, and the
// one thing being asserted here is where the game PUT him — a reading taken
// after a `__dbgTp` is a reading of the probe's own arithmetic.
//
// Four claims and they are one composition: he stands a few paces from the
// greeter (not on him, and not across the camp), at the same height, looking
// the same way, with the camera on his face rather than over his shoulder.
// `camFromFace` is the one that cannot be got any other way — it is the angle
// between where the lens SITS relative to the hero and where the hero is
// LOOKING, so ~0 is the opening shot and ~180 is every other moment in the
// game. Nothing here names a coordinate: the pose is derived from whoever
// stands nearest the middle of the start town, so a seed that moved the camp
// moves all four numbers together.
{
  const s = await page.evaluate(() => window.__dbgStart?.());
  results.openingPose = s;
  check(!!s?.greeter, 'no greeter — the pose fell back to the road');
  check(s?.beside > 2.8 && s?.beside < 5,
    `should stand a few paces from the greeter, got ${s?.beside}`);
  // Just OUTSIDE NPC_TALK_RANGE (2.8) on purpose: inside it he turns to attend
  // the hero on frame one and the two of them face each other instead of the
  // same way, which is the shot. The lower bound above is that constant.
  check(Math.abs(s?.faceGap) < 1, `should face the greeter's way, off by ${s?.faceGap} deg`);
  check(Math.abs(s?.camFromFace) < 12,
    `the camera should be on his face, ${s?.camFromFace} deg off`);
  check(Math.abs(s?.start.y - s?.greeter.y) < 0.6,
    `same ground as the greeter, ${s?.start.y} against ${s?.greeter.y}`);
  // The CONTROL, and without it the four above would all pass in a world where
  // `playerStart` had quietly fallen back to the road and the greeter happened
  // to be standing on it: the start must NOT be the world's reference point,
  // which is fifty-odd units out on the road (see World.spawnPoint).
  check(s?.fromSpawn > 20,
    `the hero should start in camp, not at the road spawn (${s?.fromSpawn} away)`);
  // And he is really there — `playerStart` is a statement, `__dbgPlayerPos` is
  // the hero. A pose nothing applied would read perfectly above.
  check(Math.abs(s?.player.x - s?.start.x) < 0.5 && Math.abs(s?.player.z - s?.start.z) < 0.5,
    'the hero is not standing where playerStart says');
}

// ---------- on the ground, two units away: he is there to talk to ----------
{
  await page.evaluate((g) => window.__dbgTp(g.x + 2.0, g.z), gain);
  await wait(800);
  const [p, row, h] = [await pos(), await gainRow(), await hint()];
  const dy = +(p.y - gain.y).toFixed(2);

  await page.keyboard.press('KeyE');
  await wait(400);
  const opened = await talking();
  await page.keyboard.press('Escape');
  await wait(300);

  results.onFoot = {
    dy, horiz: row.fromPlayer, inTalkRange: row.inTalkRange,
    hint: h, talkOpened: opened, closedAgain: await talking(),
  };
  check(Math.abs(dy) < 0.01, `expected the hero on the ground beside him, dy ${dy}`);
  check(row.inTalkRange, 'the shipped query says he is NOT in talk range, standing 2 units away');
  check(!!h && /Gains/.test(h), `no talk prompt standing beside him: ${JSON.stringify(h)}`);
  check(opened === 'gain', `E did not open the conversation (talking: ${opened})`);
}

// ---------- start a conversation, then take off out of it ----------
await cmd('/mount galebird');
{
  const m = await page.evaluate(() => window.__dbgMount?.());
  results.mount = { mounted: m?.mounted ?? false, beast: m?.beast ?? null, locomotion: m?.locomotion ?? null };
  check(m?.mounted === true, 'could not mount the galebird — the rest of the run means nothing');
  check(m?.locomotion === 'flying', `mounted something that does not fly: ${m?.locomotion}`);
}

// A flyer at REST hovers about 2.2 units up, which is his head height and is
// deliberately still inside the cylinder. Prove that before climbing, or the
// run below cannot distinguish "the height check works" from "mounting broke
// the prompt".
{
  await wait(1200);
  const [p, row] = [await pos(), await gainRow()];
  const dy = +(p.y - gain.y).toFixed(2);
  results.hovering = { dy, horiz: row.fromPlayer, inTalkRange: row.inTalkRange, hint: await hint() };
  check(dy > 1.0 && dy < 3.0, `a resting hover should sit ~2.2 above his feet, measured ${dy}`);
  check(row.inTalkRange, `hovering at his head height (dy ${dy}) must still be talkable`);
}

// Open one, then climb out of it.
await page.keyboard.press('KeyE');
await wait(400);
const openedInHover = await talking();
check(openedInHover === 'gain', `could not start a talk from the hover (talking: ${openedInHover})`);

{
  await page.keyboard.down('Space');
  await wait(2500);
  await page.keyboard.up('Space');
  await wait(400);

  const [p, row, h] = [await pos(), await gainRow(), await hint()];
  const dy = +(p.y - gain.y).toFixed(2);
  results.flying = {
    dy, horiz: row.fromPlayer, inTalkRange: row.inTalkRange,
    hint: h, stillTalking: await talking(),
  };
  // The whole bug in one number: he is directly overhead and a long way up.
  check(dy > 10, `the climb did not get high enough to test anything, dy ${dy}`);
  check(row.horiz === undefined || row.fromPlayer < 4,
    `drifted off him horizontally (${row.fromPlayer}) — this would pass for the wrong reason`);
  check(!row.inTalkRange, `STILL in talk range ${dy} units overhead — issue #25`);
  check(h === null || !/Gains/.test(h), `talk prompt still up ${dy} units overhead: ${JSON.stringify(h)}`);
  check(results.flying.stillTalking === null,
    `the conversation followed the hero into the sky (talking: ${results.flying.stillTalking})`);
}

// ---------- and pressing E up there does nothing ----------
{
  await page.keyboard.press('KeyE');
  await wait(400);
  const t = await talking();
  results.eWhileFlying = { talking: t };
  check(t === null, `E opened a conversation from the air (talking: ${t})`);
}

// ---------- come back down: it must all work again ----------
{
  await cmd('/mount off');
  await page.evaluate((g) => window.__dbgTp(g.x + 2.0, g.z), gain);
  await wait(1000);
  const row = await gainRow();
  await page.keyboard.press('KeyE');
  await wait(400);
  results.backOnFoot = { inTalkRange: row.inTalkRange, hint: await hint(), talking: await talking() };
  check(row.inTalkRange, 'not talkable again after landing — the check latched');
  check(results.backOnFoot.talking === 'gain', 'could not talk again after landing');
}

console.log(JSON.stringify({ gain: { x: gain.x, y: gain.y, z: gain.z }, ...results, fails }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
