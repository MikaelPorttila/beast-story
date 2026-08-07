// Verifies that a companion only spends a skill while there is a fight to join
// (issue #124).
//
// Usage: bun tools/test-beastcast.mjs        (dev server must be up)
//
// The support slot deliberately drives its own skills, but its timer used to be
// the whole decision: every 6-10 seconds it fired whether an enemy existed or
// not. Because either bonded beast can occupy that slot, swapping them made both
// animals appear to attack at random while following the player around.
//
// This probe asserts both halves of the rule. Eight simulated seconds in an
// enemy-free world must produce no cast; placing an enemy beside the party must
// then produce one. The control matters: a build that disables support skills
// completely would satisfy the first assertion and still be broken.
//
// Exits non-zero on failure.
import { launchBrowser, newPage } from './browser.mjs';
import { BASE as HOST, NO_WARMUP } from './target.mjs';

const browser = await launchBrowser();
const page = await newPage(browser, { width: 1280, height: 800 });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));

// No ambient population: the test creates the one enemy that separates its
// control from its positive case. Nothing here reads pixels, so shader warm-up
// would add boot time without adding coverage.
await page.goto(`${HOST}/?menu=0&fs=0&vol=0&enemies=0&${NO_WARMUP}`, { waitUntil: 'load' });
await page.waitForSelector('canvas');
await page.waitForFunction(
  () => window.__dbgBoot?.().playing && window.__dbgAdvance,
  { timeout: 60000 },
);

const results = {};
const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); };
const adv = (seconds) => page.evaluate((s) => window.__dbgAdvance(s), seconds);
const party = () => page.evaluate(() => window.__dbgCompanions());
const cast = () => page.evaluate(() => window.__dbgMount().lastCast);

for (const id of ['emberfox', 'galebird']) {
  await page.evaluate((species) => window.__dbgGrantBeast(species), id);
}
await adv(0.2);

// -- no enemy: the support timer may expire, but no skill is spent ---------
const idleBefore = await cast();
await adv(8);
const idleParty = await party();
const idleAfter = await cast();
results.idle = { party: idleParty, before: idleBefore, after: idleAfter };
check(idleParty.needed === false, 'the enemy-free control reported a nearby fight');
check(idleAfter.skill === idleBefore.skill,
  `support cast ${idleAfter.skill} with no enemy nearby`);

// -- nearby enemy: the same support AI now has a reason to cast ------------
const spawned = await page.evaluate(() => window.__dbgSpawn('enemies', 'wild-sproutle'));
await adv(0.3);
const combatParty = await party();
const combatCast = await cast();
results.combat = { spawned, party: combatParty, cast: combatCast };
check(combatParty.needed === true, 'the staged enemy did not put the party in combat');
check(combatCast.skill !== idleAfter.skill && combatCast.skill.length > 0,
  'support did not cast after an enemy entered its combat range');
check(combatCast.homing === true, 'the combat support cast did not target the staged enemy');

console.log(JSON.stringify({ ...results, fails }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
