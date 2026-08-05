// Verifies the inventory (issue #74): the panel, the three gear slots, and the
// four things a player can do to something they own.
//
// Usage: bun tools/test-inventory.mjs      (dev server must be up)
//
// EVERY CLAIM IS ABOUT A NUMBER THE SCREEN CANNOT SHOW, and that is the whole
// design of this file. An icon sitting in the weapon slot looks identical
// whether or not equipping it did anything, so equipping is asserted on
// `attackStat`; a potion drunk looks identical to a potion clicked, so using is
// asserted on hp AND on the stack going down; a dropped item looks identical to
// a deleted one, so dropping is asserted on the item being ON THE GROUND
// afterwards. `__dbgInventory()` reports all of it.
//
// THREE SECTIONS ARE PAIRS, for the reason every other probe in tools/ that says
// so gives — one arm alone passes against a broken build:
//
//   * `I` opens AND the hero is frozen while it is up. "The panel appeared" is
//     equally true of a modal and of a picture drawn over a hero still walking
//     into a lake, which is the bug the modal rule exists to prevent.
//   * Salvage removes the stack AND pays out. Either alone passes for a button
//     that destroys your things for nothing, or one that prints money.
//   * Drop removes the stack AND leaves a drop on the ground that does NOT come
//     straight back. Without the second half it passes for a Drop that is a
//     Delete; without the third it passes for the version of this that shipped
//     first, where the item magnetted back into the bag before the toast faded.
//
// A QUEST ITEM IS THE CONTROL for the destructive half. Everything the panel
// refuses to do it refuses on exactly one kind, so a run where drop and salvage
// worked on everything would pass every assertion above — section 6 is what
// says the refusal is a rule rather than an accident of which items were held.
//
// Exits non-zero on failure.
import { launchBrowser, newPage, wait } from './browser.mjs';
import { BASE as HOST } from './target.mjs';

const URL = `${HOST}/?menu=0&fs=0&fps=30`;
const browser = await launchBrowser();
const page = await newPage(browser, { width: 1280, height: 800 });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));

await page.goto(URL, { waitUntil: 'load' });
await page.waitForSelector('canvas');
await wait(5000);
await page.focus('canvas').catch(() => {});

const inv = () => page.evaluate(() => window.__dbgInventory());
const act = (id, action) => page.evaluate((a, b) => window.__dbgInvAction(a, b), id, action);
const give = (id, n) => page.evaluate((a, b) => window.__dbgGive?.(a, b), id, n);
const pos = () => page.evaluate(() => window.__dbgPlayerPos());
const ground = () => page.evaluate(() => window.__dbgFetch().drops);
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

const results = {};
const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); };

const boot = await inv();
if (!boot) {
  console.error('__dbgInventory is not there — nothing below can run');
  await browser.close();
  process.exit(1);
}

// ---------- 1. the starting kit, and the loadout it implies ----------
{
  const kinds = Object.fromEntries(boot.bag.map((e) => [e.id, e]));
  results.start = {
    bag: boot.bag,
    weapon: boot.weapon,
    baseAttack: boot.baseAttack,
    attackStat: boot.attackStat,
    gear: boot.gear,
    beastRows: boot.entries.filter((e) => e.kind === 'beast').length,
  };
  check(!!kinds['sword-iron'], 'no starting weapon in the bag');
  check(!!kinds['potion-mend'], 'no starting potion in the bag');
  check(!!kinds['bp-dagger'], 'no starting blueprint in the bag');
  // The gear slot is doing something, which is the one claim the picture cannot
  // make: base 14, iron sword +4.
  check(boot.attackStat === boot.baseAttack + 4,
    `attackStat ${boot.attackStat} is not base ${boot.baseAttack} + the sword's 4`);
  check(boot.gear.find((g) => g.slot === 'weapon')?.id === 'sword-iron',
    'the weapon slot does not hold the starting sword');
  // Beasts are ROSTER-DERIVED rows, not bag entries — see BEAST_ID_PREFIX. Ten
  // of them, and none of them in the bag.
  check(results.start.beastRows === 10,
    `${results.start.beastRows} beast rows, expected the whole roster of 10`);
  check(!boot.bag.some((e) => e.id.startsWith('beast:')),
    'a beast is stored in the bag — it must be derived from the roster');
  const gearBeasts = boot.gear.filter((g) => g.slot !== 'weapon').map((g) => g.id);
  check(gearBeasts.every((id) => id && id.startsWith('beast:')),
    `the two beast slots are not filled: ${JSON.stringify(gearBeasts)}`);
}

// ---------- 2. `I` opens it, AND the hero is frozen behind it ----------
// The pair. `travel` with the panel up must be 0, and the identical hold with it
// down must move him — otherwise "0" is a hero who could not walk anyway.
{
  const hold = async (ms) => {
    const a = await pos();
    await page.keyboard.down('KeyW');
    await wait(ms);
    await page.keyboard.up('KeyW');
    await wait(120);
    return dist(a, await pos());
  };

  await page.keyboard.press('KeyI');
  await wait(400);
  const open = await inv();
  const travelOpen = await hold(1200);

  await page.keyboard.press('KeyI');
  await wait(400);
  const shut = await inv();
  // Aimed along the hero's OWN heading first: the opening pose puts the camera
  // in FRONT of him and `KeyW` follows the camera, so a walk from the fire runs
  // into a hut wall two units on. See the playerStart note in AGENTS.md.
  await page.mouse.move(640, 400);
  await page.evaluate(() => window.__dbgTp?.(
    window.__dbgTowns().spawn.x, window.__dbgTowns().spawn.z,
  ));
  await wait(900);
  const travelShut = await hold(1200);

  results.modal = {
    openedByKey: open.open,
    closedByKey: !shut.open,
    panel: open.panel,
    travelWithPanelUp: +travelOpen.toFixed(2),
    travelWithPanelDown: +travelShut.toFixed(2),
  };
  check(open.open === true, 'I did not open the inventory');
  check(shut.open === false, 'I did not close the inventory again');
  check(travelOpen < 0.5,
    `the hero travelled ${travelOpen.toFixed(2)} with the panel up — it must be a modal`);
  check(travelShut > 3,
    `the hero travelled only ${travelShut.toFixed(2)} with the panel down — `
    + 'the frozen reading above proves nothing');
  // The panel drew what the model holds: thirteen rows at boot (ten beasts and
  // three items), three gear slots, seven tabs. The ICON count is separate and
  // is the only thing that can catch a broken atlas — a slot with no background
  // renders perfectly and looks like a slot.
  check(open.panel?.slots === 13,
    `${open.panel?.slots} slots drawn, expected 13`);
  check(open.panel?.gearSlots === 3,
    `${open.panel?.gearSlots} gear slots drawn, expected 3`);
  check(open.panel?.tabs === 7, `${open.panel?.tabs} tabs drawn, expected 7`);
  check((open.panel?.icons ?? 0) >= 2,
    `${open.panel?.icons} atlas icons drawn — the weapon and the blueprint both have one`);
}

// ---------- 3. equip and unequip move the stat ----------
{
  const before = await inv();
  await act('sword-iron', 'unequip');
  const bare = await inv();
  await act('sword-iron', 'equip');
  const armed = await inv();
  results.equip = {
    equipped: before.attackStat,
    bare: bare.attackStat,
    reEquipped: armed.attackStat,
    bareGear: bare.gear.find((g) => g.slot === 'weapon')?.id ?? null,
  };
  check(bare.attackStat === bare.baseAttack,
    `unequipped, attackStat is ${bare.attackStat} and should be the base ${bare.baseAttack}`);
  check(bare.weapon === null && results.equip.bareGear === null,
    'the weapon slot still holds something after unequip');
  check(armed.attackStat === before.attackStat,
    `re-equipping gave ${armed.attackStat}, not the ${before.attackStat} it started at`);
  // An EQUIPPED weapon may not be destroyed out from under the gear slot.
  const row = armed.entries.find((e) => e.id === 'sword-iron');
  check(!row.actions.includes('drop') && !row.actions.includes('salvage'),
    `the equipped sword still offers ${JSON.stringify(row.actions)}`);
}

// ---------- 4. using a potion: hp up, stack down, buff on a clock ----------
{
  // Hurt him first, or a heal on a full-health hero measures nothing.
  await page.evaluate(() => window.__dbgHurt?.(45));
  await wait(250);
  const hurt = await inv();
  await act('potion-mend', 'use');
  await wait(250);
  const healed = await inv();

  await give('potion-fury', 1);
  const gotFury = await inv();
  await act('potion-fury', 'use');
  await wait(250);
  const furious = await inv();

  const countOf = (snap, id) => snap.bag.find((e) => e.id === id)?.count ?? 0;
  results.use = {
    hpBefore: hurt.hp,
    hpAfter: healed.hp,
    potionsBefore: countOf(hurt, 'potion-mend'),
    potionsAfter: countOf(healed, 'potion-mend'),
    furyGiven: countOf(gotFury, 'potion-fury'),
    buff: furious.buff,
    attackWithBuff: furious.attackStat,
  };
  check(hurt.hp < 100, `the hero is on ${hurt.hp} hp — nothing to heal, section 4 proves nothing`);
  check(healed.hp > hurt.hp, `hp did not move: ${hurt.hp} -> ${healed.hp}`);
  check(results.use.potionsAfter === results.use.potionsBefore - 1,
    `the stack went ${results.use.potionsBefore} -> ${results.use.potionsAfter}, expected one fewer`);
  check(results.use.furyGiven === 1, 'the console give of a fury draught did not land');
  check(furious.buff.attack === 10 && furious.buff.seconds > 0,
    `the buff reads ${JSON.stringify(furious.buff)}, expected +10 on a running clock`);
  check(furious.attackStat === furious.baseAttack + 4 + 10,
    `buffed attackStat is ${furious.attackStat}, expected base + sword + draught`);
}

// ---------- 5. salvage pays, and drop lands on the ground ----------
{
  const before = await inv();
  await act('bp-dagger', 'salvage');
  const sold = await inv();
  results.salvage = {
    shardsBefore: before.shards,
    shardsAfter: sold.shards,
    gone: !sold.bag.some((e) => e.id === 'bp-dagger'),
  };
  // The dagger blueprint is worth 3 (core/items.ts).
  check(sold.shards === before.shards + 3,
    `salvage paid ${sold.shards - before.shards}, expected the blueprint's 3`);
  check(results.salvage.gone, 'the salvaged blueprint is still in the bag');

  await give('glowpebble', 2);
  const held = await inv();
  const where = await pos();
  await act('glowpebble', 'drop');
  await wait(300);
  const dropped = await inv();
  const onGround = (await ground()).filter((d) => d.itemId === 'glowpebble');
  // AND IT STAYS DROPPED. The hero is standing on top of it; an ARMED drop
  // magnets back inside a third of a second, so waiting is the assertion.
  await wait(1600);
  const after = await inv();

  const countOf = (snap) => snap.bag.find((e) => e.id === 'glowpebble')?.count ?? 0;
  results.drop = {
    held: countOf(held),
    afterDrop: countOf(dropped),
    onGround: onGround.length,
    stillOutAfter1p6s: countOf(after),
    heroMoved: +dist(where, await pos()).toFixed(2),
  };
  check(countOf(dropped) === countOf(held) - 1,
    `the stack went ${countOf(held)} -> ${countOf(dropped)}, expected one fewer`);
  check(onGround.length >= 1,
    'nothing is on the ground after the drop — Drop must not be Delete');
  check(countOf(after) === countOf(dropped),
    `the drop came back on its own (${countOf(dropped)} -> ${countOf(after)}) — `
    + 'a fresh drop is unarmed until the player walks away from it');
}

// ---------- 6. the control: a quest item refuses both ----------
{
  await give('gain-token', 1);
  const held = await inv();
  const row = held.entries.find((e) => e.id === 'gain-token');
  // Ask anyway. The refusal has to be in the HANDLER and not only in which
  // buttons were drawn, or a panel bug is a way to delete a quest item.
  await act('gain-token', 'drop');
  await act('gain-token', 'salvage');
  const after = await inv();
  results.quest = {
    actions: row?.actions ?? null,
    countBefore: held.bag.find((e) => e.id === 'gain-token')?.count ?? 0,
    countAfter: after.bag.find((e) => e.id === 'gain-token')?.count ?? 0,
    shardsBefore: held.shards,
    shardsAfter: after.shards,
  };
  check(!!row, 'the quest item never reached the bag');
  check(row && row.actions.length === 0,
    `a quest item offers ${JSON.stringify(row?.actions)} — it must offer neither`);
  check(results.quest.countAfter === results.quest.countBefore,
    'a quest item was destroyed by a direct call to the action handler');
  check(results.quest.shardsAfter === results.quest.shardsBefore,
    'salvaging a quest item paid out');
}

// ---------- 7. the beast slots are the SAME two Tab moves ----------
// Not a second copy of the roster picks: equipping a benched beast from the
// panel and then pressing Tab has to land where a player expects, which it can
// only do if both are writing `primaryIdx`/`supportIdx`.
{
  const before = await inv();
  const benched = before.entries.find((e) => e.kind === 'beast' && !e.equipped);
  await act(benched.id, 'setLead');
  const led = await inv();
  await page.keyboard.press('Tab');
  await wait(300);
  const swapped = await inv();
  const slotOf = (snap, s) => snap.gear.find((g) => g.slot === s)?.id ?? null;
  results.beastSlots = {
    picked: benched.id,
    afterSetLead: { lead: slotOf(led, 'primary'), support: slotOf(led, 'support') },
    afterTab: { lead: slotOf(swapped, 'primary'), support: slotOf(swapped, 'support') },
  };
  check(slotOf(led, 'primary') === benched.id,
    `setLead put ${slotOf(led, 'primary')} in front, not ${benched.id}`);
  check(slotOf(swapped, 'support') === benched.id,
    'Tab did not move the beast the panel had just equipped — the panel is keeping '
    + 'its own copy of the roster picks');
  check(slotOf(swapped, 'primary') === slotOf(led, 'support'),
    'Tab did not bring the support beast to the front');
}

console.log(JSON.stringify({ ...results, fails }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
