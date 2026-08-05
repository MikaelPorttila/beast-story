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
/**
 * How many species the roster holds — three separate assertions below are this
 * number, so it is named once rather than written out three times.
 *
 * TEN UNTIL ISSUE #76, which added the five water beasts (Rivotter, Coralback,
 * Finnick, Snapclaw, Lanternfin). Moved here rather than derived from
 * `ALL_SPECIES.length` at run time deliberately: derived, every one of these
 * checks would agree with whatever the build happens to contain and none of
 * them could ever fail. A written-down number is what makes "the roster
 * silently lost a beast" a test failure.
 *
 * The wall is a fixed 11x3 of thirty-three (INV_COLS), so the roster plus the
 * three starting items has fifteen cells of headroom left. Past that the wall
 * is the thing to change, not this.
 */
const ROSTER = 15;

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
  // Beasts are ROSTER-DERIVED rows, not bag entries — see BEAST_ID_PREFIX. The
  // whole roster of them, and none of them in the bag.
  check(results.start.beastRows === ROSTER,
    `${results.start.beastRows} beast rows, expected the whole roster of ${ROSTER}`);
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
  // The stage bakes one portrait per frame, so the roster's ten are a second or
  // so behind the first paint by construction — see InventoryStage.iconFor.
  await wait(1200);
  const baked = await inv();

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
    portraitsAfter1p2s: baked.panel?.portraits ?? null,
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
  // The panel drew what the model holds: every beast plus the three starting
  // items, FILLED, inside a fixed 11x3 wall of thirty-three, three gear slots,
  // seven tabs. Both numbers, because the wall's shape is the feature — a grid
  // that shrank to what you happen to own is the thing INV_COLS exists to
  // prevent, and a roster that outgrew the wall is the other way it breaks.
  check(open.panel?.filled === ROSTER + 3,
    `${open.panel?.filled} filled cells, expected ${ROSTER + 3}`);
  check(open.panel?.slots === 33,
    `${open.panel?.slots} cells drawn, expected a fixed 11x3 of 33`);
  check(open.panel?.gearSlots === 3,
    `${open.panel?.gearSlots} gear slots drawn, expected 3`);
  check(open.panel?.tabs === 7, `${open.panel?.tabs} tabs drawn, expected 7`);
  // Two ATLAS icons is the weapon and the blueprint, and it is the only thing
  // that can catch a broken sprite sheet — a slot whose background failed to
  // load renders perfectly and looks like a slot.
  check((open.panel?.icons ?? 0) >= 2,
    `${open.panel?.icons} atlas icons drawn — the weapon and the blueprint both have one`);
  // THE 3D HALF. `stageGl` says the second WebGL context came up at all;
  // `portraits` says it rendered a distinct beast INTO every wall slot, which is
  // the feature — a slot showing its element lozenge is what this looked like
  // before, and it looks perfectly fine.
  check(open.panel?.stageGl === true, 'no stage canvas in the panel');
  check((baked.panel?.portraits ?? 0) === ROSTER,
    `${baked.panel?.portraits} beast portraits baked after 1.2 s, `
    + `expected the roster's ${ROSTER}`);
}

// ---------- 2b. the tooltip, and the detail pane's absence ----------
// The tooltip is the description now, so it has to be asserted on TEXT: an
// empty box that opens on hover would pass any "is it visible" test.
{
  await page.keyboard.press('KeyI');
  await wait(400);
  // `page.hover`, not `mouse.move` to the slot's centre: a bare CDP mouse move
  // does not make the browser synthesise the pointerover this listens for, and
  // the version of this section that used one read a null tooltip against a
  // panel that was working perfectly in the hand.
  await page.hover('.bs-inv .slot[data-sel="potion-mend"]');
  await wait(250);
  const hovered = await inv();
  const tipBox = await page.evaluate(() => {
    const t = document.querySelector('.bs-inv .tip');
    const r = t.getBoundingClientRect();
    return {
      on: t.classList.contains('on'),
      right: Math.round(r.right), bottom: Math.round(r.bottom),
      w: Math.round(r.width), h: Math.round(r.height),
      inFrame: r.left >= 0 && r.top >= 0
        && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
    };
  });
  // Off any row, and onto something that is still inside the panel — the
  // tooltip hides on leaving a slot, not on leaving the panel.
  await page.hover('.bs-inv .head h2');
  await wait(250);
  const away = await inv();

  results.tooltip = {
    text: hovered.panel?.tip,
    box: tipBox,
    goneOnLeave: away.panel?.tip === null,
    detailPanes: await page.evaluate(() => document.querySelectorAll('.bs-inv .detail').length),
  };
  check(!!hovered.panel?.tip && hovered.panel.tip.includes('Mending'),
    `the tooltip reads ${JSON.stringify(hovered.panel?.tip)} — it should name the item`);
  check(hovered.panel.tip.includes('Restores'),
    'the tooltip carries no stats — it replaced a pane that did');
  // CLAMPED INTO THE WINDOW. The dock is against the right edge, so every slot
  // is within a tooltip's width of it: unclamped, this is the assertion that
  // fails, and it fails off screen where nobody sees it.
  check(tipBox.inFrame, `the tooltip is outside the window: ${JSON.stringify(tipBox)}`);
  check(results.tooltip.goneOnLeave, 'the tooltip stayed up after the pointer left');
  check(results.tooltip.detailPanes === 0, 'a detail pane is still in the markup');
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

// ---------- 3b. right-click runs the row's primary action ----------
// A PAIR, and it has to be: "right-click unequipped it" is equally true of a
// working primary action and of a handler wired to `unequip` whatever it is
// looking at. The same gesture on the same slot has to put it back.
{
  const rmb = (sel) => page.evaluate((s) => {
    const el = document.querySelector(`.bs-inv .slot[data-sel="${s}"]`);
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  }, sel);

  const before = await inv();
  await rmb('sword-iron');
  await wait(200);
  const off = await inv();
  await rmb('sword-iron');
  await wait(200);
  const on = await inv();

  results.rightClick = {
    startedEquipped: before.weapon,
    afterFirst: off.weapon,
    afterSecond: on.weapon,
    attackAfterFirst: off.attackStat,
    attackAfterSecond: on.attackStat,
  };
  check(before.weapon === 'sword-iron', 'section 3b did not start with the sword equipped');
  check(off.weapon === null,
    `right-click left the weapon as ${off.weapon} — its primary action is unequip`);
  check(on.weapon === 'sword-iron',
    `the second right-click left ${on.weapon} — it should have put the sword back`);
  check(on.attackStat === before.attackStat,
    `attackStat ended at ${on.attackStat}, not the ${before.attackStat} it started at`);
}

// ---------- 3c. drag onto a gear slot, and off the panel ----------
// The gestures, through real DragEvents with a real DataTransfer — synthetic,
// because CDP cannot drive an HTML5 drag, but through the SAME listeners a
// mouse reaches: the panel reads `event.target` and its own `dragging` id and
// nothing else.
{
  const drag = (fromSel, toSel) => page.evaluate((f, t) => {
    const dt = new DataTransfer();
    const src = document.querySelector(f);
    const dst = document.querySelector(t);
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  }, fromSel, toSel);

  await give('greatsword-iron', 1);
  await wait(250);

  // A weapon onto the WEAPON slot: equip.
  await drag('.bs-inv .slot[data-sel="greatsword-iron"]', '.bs-inv .gs[data-gear="weapon"]');
  await wait(250);
  const equipped = await inv();

  // A POTION onto the weapon slot: refused, and refused by the PANEL — the host
  // never hears about it, because the host never listed `equip` for a potion.
  // Without this the drag half passes for a panel that sends every drop.
  await drag('.bs-inv .slot[data-sel="potion-mend"]', '.bs-inv .gs[data-gear="weapon"]');
  await wait(250);
  const stillArmed = await inv();

  // A benched beast onto the LEAD slot.
  const benched = equipped.entries.find((e) => e.kind === 'beast' && !e.equipped);
  await drag(`.bs-inv .slot[data-sel="${benched.id}"]`, '.bs-inv .gs[data-gear="primary"]');
  await wait(250);
  const led = await inv();

  // And off the panel entirely, onto the world: drop.
  const heldBefore = led.bag.find((e) => e.id === 'sunberry')?.count ?? 0;
  await give('sunberry', 2);
  await wait(250);
  await drag('.bs-inv .slot[data-sel="sunberry"]', '.bs-inv .bs-scrim');
  await wait(300);
  const dropped = await inv();

  const slotOf = (snap, s) => snap.gear.find((g) => g.slot === s)?.id ?? null;
  results.drag = {
    ontoWeapon: equipped.weapon,
    potionRefused: stillArmed.weapon,
    ontoLead: slotOf(led, 'primary'),
    wanted: benched.id,
    sunberriesBefore: heldBefore + 2,
    sunberriesAfter: dropped.bag.find((e) => e.id === 'sunberry')?.count ?? 0,
  };
  check(equipped.weapon === 'greatsword-iron',
    `dragging the greatsword onto the weapon slot left ${equipped.weapon}`);
  check(stillArmed.weapon === 'greatsword-iron',
    `a potion dropped on the weapon slot changed it to ${stillArmed.weapon} — `
    + 'the slot must refuse what the host never offered');
  check(slotOf(led, 'primary') === benched.id,
    `dragging ${benched.id} onto the lead slot left ${slotOf(led, 'primary')}`);
  check(results.drag.sunberriesAfter === results.drag.sunberriesBefore - 1,
    `dragging off the panel took the stack ${results.drag.sunberriesBefore} -> `
    + `${results.drag.sunberriesAfter}, expected one fewer`);
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
  // RELATIVE to what he had a moment ago, not to a weapon named here: section
  // 3c leaves whatever it last dragged onto the slot, and an absolute figure
  // makes this section fail on a change three sections above it.
  check(furious.attackStat === gotFury.attackStat + 10,
    `buffed attackStat is ${furious.attackStat}, expected ${gotFury.attackStat} + the draught's 10`);
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
  // THE PANEL HAS TO BE SHUT FOR THIS ONE. Tab is read in a simulation slice
  // and every modal in the game freezes those, so a Tab pressed with the
  // inventory up is a Tab the hero never sees — which reads exactly like the
  // failure this section is looking for, and did, for one run.
  if ((await inv()).open) { await page.keyboard.press('KeyI'); await wait(350); }
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

// ---------- 9. the stage survives a swap ----------
// THE REPORTED BUG. Sending a beast that is already in one slot to the OTHER
// one is a swap, and the stage used to fill its two marks one at a time:
// slot 0 took the support beast's rig, then slot 1's turn removed "whatever
// used to be in slot 1" — the same rig, one line later. One of the two beasts
// simply vanished from the preview and stayed gone.
//
// It is asserted on what is IN THE SCENE (`stageCast`) rather than on what the
// panel asked for, because those are exactly the two things that disagreed.
{
  if (!(await inv()).open) { await page.keyboard.press('KeyI'); await wait(500); }
  const idOf = (s) => s.replace('beast:', '');
  const before = await inv();
  const lead = before.gear.find((g) => g.slot === 'primary').id;
  const support = before.gear.find((g) => g.slot === 'support').id;

  // Send the SUPPORT beast to the front — a swap, and the failing case.
  await act(support, 'setLead');
  await wait(250);
  const swapped = await inv();
  // And back, so the pair is closed and a one-way fluke cannot pass.
  await act(lead, 'setLead');
  await wait(250);
  const back = await inv();

  results.stageSwap = {
    startCast: before.panel?.stageCast,
    afterSwap: swapped.panel?.stageCast,
    afterSwapBack: back.panel?.stageCast,
    gearAfterSwap: swapped.gear.map((g) => g.id),
  };
  const full = (c) => Array.isArray(c) && c.length === 2 && c.every((x) => !!x);
  check(full(before.panel?.stageCast),
    `the stage started with ${JSON.stringify(before.panel?.stageCast)}, expected two beasts`);
  check(full(swapped.panel?.stageCast),
    `after a swap the stage holds ${JSON.stringify(swapped.panel?.stageCast)} — `
    + 'one of the two models was removed from the scene');
  check(full(back.panel?.stageCast),
    `after swapping back the stage holds ${JSON.stringify(back.panel?.stageCast)}`);
  // ...and it is drawing the beasts the GEAR SLOTS name, in that order, rather
  // than merely two of something.
  check(swapped.panel.stageCast[0] === idOf(swapped.gear.find((g) => g.slot === 'primary').id)
    && swapped.panel.stageCast[1] === idOf(swapped.gear.find((g) => g.slot === 'support').id),
    'the stage is drawing beasts the gear slots do not name');
}

// ---------- 8. the weapon in his hand, and what it does ----------
// The gear slot was a NUMBER until the models landed: equipping a scythe raised
// attackStat and the hero went on swinging an iron sword. So every claim here
// is about `player.weapon`, which is read off the RIG rather than off a field
// beside it — there is no second copy that could agree while the model on
// screen does not.
{
  const shots = () => page.evaluate(() => window.__dbgShots());
  // A DELTA, not a count. An arrow lives 1.6 s and the pool is shared, so the
  // one fired by the bow is still in the air when the sword swings a moment
  // later — the first version of this section read it as the sword's and
  // failed against a perfectly correct build.
  const swing = async () => {
    const before = (await shots()).shots.filter((s) => s.arrow).length;
    await page.mouse.down();
    await wait(70);
    await page.mouse.up();
    await wait(160);
    const after = await shots();
    return { ...after, fired: after.shots.filter((s) => s.arrow).length - before };
  };

  // Somewhere with room, and off the panel: a swing is a simulation slice.
  if ((await inv()).open) { await page.keyboard.press('KeyI'); await wait(350); }
  await page.evaluate(() => window.__dbgTp?.(
    window.__dbgTowns().spawn.x, window.__dbgTowns().spawn.z,
  ));
  await wait(900);

  const seen = {};
  for (const [item, model] of [
    ['sword-iron', 'sword'], ['greatsword-iron', 'greatsword'],
    ['bow-ash', 'bow'], ['scythe-reaper', 'scythe'], ['dagger-quick', 'dagger'],
  ]) {
    await give(item, 1);
    await act(item, 'equip');
    await wait(200);
    seen[item] = (await shots()).weapon;
    check(seen[item] === model,
      `equipping ${item} left the hero holding ${seen[item]}, expected ${model}`);
  }

  // THE BOW FIRES AN ARROW, and the `arrow` flag is the whole assertion: the
  // projectile pool is shared with every skill in the game, so a bow that came
  // out as a fireball would look identical in a count and in a screenshot.
  await act('bow-ash', 'equip');
  await wait(200);
  const fired = await swing();
  const arrows = fired.shots.filter((s) => s.arrow);

  // ...and a MELEE weapon does not. The pair: "an arrow appeared" is equally
  // true of a bow and of a build where every swing spawns one.
  await act('sword-iron', 'equip');
  await wait(200);
  const swung = await swing();

  // BARE HANDS. Unequipping leaves the hand empty, which is what puts the
  // animator on the punch table (PUNCHES, player/animations.ts) — the poses
  // themselves are not something a probe can see, so what is asserted is the
  // one input that selects them, plus the stat falling back to the base.
  await act('sword-iron', 'unequip');
  await wait(200);
  const bare = await shots();
  const punched = await swing();

  results.weapons = {
    equipped: seen,
    bowShots: fired.fired,
    bowShotSpeed: arrows[0]?.speed ?? null,
    swordShots: swung.fired,
    bareWeapon: bare.weapon,
    bareAttack: bare.attackStat,
    bareShots: punched.fired,
  };
  check(fired.fired >= 1, 'the bow fired nothing');
  check((arrows[0]?.speed ?? 0) > 8,
    `the arrow is travelling at ${arrows[0]?.speed} — it should be in flight, not parked`);
  check(results.weapons.swordShots === 0,
    'a sword swing fired an arrow — only the bow may');
  check(bare.weapon === null, `unequipping left ${bare.weapon} in his hand`);
  check(results.weapons.bareShots === 0, 'bare hands fired an arrow');
}

// ---------- 10. Escape closes the inventory and NOTHING ELSE ----------
// THE REPORTED BUG, and it is not double-handling of the key — the cancel
// branch in main.ts already routes one press to one panel. It is the POINTER
// LOCK, and it is the same 8 ms hazard ui/pause.ts documents at length:
//
//   Escape (no keyboard lock) -> the panel closes -> its onClose re-takes the
//   lock -> the browser's own fullscreen exit, from that SAME key, drops the
//   lock a few milliseconds later -> Input.onLockLost reads a lock that was
//   TAKEN and taps a virtual Escape -> the next frame has no modal up, so the
//   in-game menu opens.
//
// The lock going away is driven from the page here (`document.exitPointerLock`)
// because that is precisely what the browser does to it, and because CDP cannot
// make a synthetic Escape release a real lock. Arm 1b of tools/test-pause.mjs
// drives the same edge the same way.
//
// A PAIR, and the second half is what stops this passing against a build with
// `onLockLost` deleted: a lock taken while NOTHING is open must still raise the
// menu, because that is the feature the hook exists for.
{
  const menuOpen = () => page.evaluate(() => !!document.querySelector('.bs-pause'));
  const closeAll = async () => {
    await page.evaluate(() => {
      document.querySelector('.bs-pause [data-act="continue"]')?.click();
    });
    if ((await inv()).open) await page.keyboard.press('KeyI');
    await wait(350);
  };

  await closeAll();
  // A real click, so the page is actually holding a lock to lose.
  await page.mouse.click(300, 400);
  await wait(250);

  await page.keyboard.press('KeyI');
  await wait(350);
  const opened = (await inv()).open;
  await page.keyboard.press('Escape');
  await wait(250);
  const closed = !(await inv()).open;
  // ...and now the browser takes the pointer back, on the same key.
  await page.evaluate(() => document.exitPointerLock());
  await wait(400);
  const menuAfterEscape = await menuOpen();

  await closeAll();
  // THE CONTROL: nothing open, the lock is taken, the menu must appear.
  await page.mouse.click(300, 400);
  await wait(250);
  await page.evaluate(() => document.exitPointerLock());
  await wait(400);
  const menuFromBareLoss = await menuOpen();
  await closeAll();

  results.escape = {
    openedByI: opened,
    closedByEscape: closed,
    menuAfterEscape,
    menuFromBareLoss,
  };
  check(opened, 'I did not open the panel for section 10');
  check(closed, 'Escape did not close the inventory');
  check(menuAfterEscape === false,
    'Escape closed the inventory AND opened the in-game menu — the panel must '
    + 'spend that press, and its onClose must not re-take a lock the browser is '
    + 'about to knock out');
  check(menuFromBareLoss === true,
    'a pointer lock taken with nothing open did not raise the menu — the '
    + 'assertion above is passing because the hook is dead, not because it is fixed');
}

// ---------- 11. the skill den closes on Escape, and NOTHING ELSE ----------
// THE SAME REPORT, one panel over, and a DIFFERENT cause — which is why it is
// its own section rather than a second arm of 10. The shop had a private
// keyboard path: ui/index.ts added its own `document` keydown listener while it
// was open, so Escape closed it SYNCHRONOUSLY, and by the time the simulation
// slice read the same press there was no modal left — so the slice took the
// other branch and opened the in-game menu. One press, two panels, and no
// pointer lock involved at all.
//
// ui/pause.ts's header names this exact hazard ("one press seen twice, once by
// this listener and once by the host's slice") and that is why neither the
// pause menu nor the inventory handles Escape in its own markup. The shop is
// the one that did.
//
// A PAIR: Escape must close the den AND leave the menu shut, and the SAME key
// with nothing open must still raise the menu — otherwise this passes against a
// build where Escape does nothing at all.
{
  const menuOpen = () => page.evaluate(() => !!document.querySelector('.bs-pause'));
  const shopOpen = () => page.evaluate(() => !!document.querySelector('.bs-shopwrap.open'));
  const shut = async () => {
    await page.evaluate(() => {
      document.querySelector('.bs-pause [data-act="continue"]')?.click();
    });
    if ((await inv()).open) await page.keyboard.press('KeyI');
    await wait(300);
  };

  await shut();
  // Stand at a den. `__dbgShops` reports where they were sited, so nothing here
  // pins a coordinate to a seed.
  // IN FRONT OF IT, not on it. `facing` is the bearing from the den toward the
  // spawn (see __dbgShops), which is the side its counter is on, and standing
  // ON the den lands the hero inside a solid building — the dens grew colliders
  // when the settlements did. 2.6 units out is inside `nearShop`'s 3.5.
  const den = (await page.evaluate(() => window.__dbgShops()))[0];
  await page.evaluate(
    (x, z, f) => window.__dbgTp(x + Math.sin(f) * 2.6, z + Math.cos(f) * 2.6),
    den.x, den.z, den.facing,
  );
  await wait(1200);
  // A real click first, so the page is holding the pointer lock the den is
  // about to hand back — which is the state a player is always in.
  await page.mouse.click(400, 400);
  await wait(250);

  await page.keyboard.press('KeyE');
  await wait(500);
  const openedByE = await shopOpen();
  await page.keyboard.press('Escape');
  await wait(500);
  const closedByEscape = !(await shopOpen());
  const menuAfterEscape = await menuOpen();
  await shut();

  // THE CONTROL: with nothing open, Escape is the menu key and must work.
  await page.keyboard.press('Escape');
  await wait(400);
  const menuFromBareEscape = await menuOpen();
  await shut();

  results.den = {
    at: { x: den.x, z: den.z },
    openedByE,
    closedByEscape,
    menuAfterEscape,
    menuFromBareEscape,
  };
  check(openedByE, 'E did not open the skill den — nothing below this means anything');
  check(closedByEscape, 'Escape did not close the skill den');
  check(menuAfterEscape === false,
    'Escape closed the skill den AND opened the in-game menu — the shop must not '
    + 'have a keyboard path of its own, or the slice sees no modal and opens the menu');
  check(menuFromBareEscape === true,
    'Escape with nothing open did not open the menu — the assertion above is '
    + 'passing because the key is dead, not because it is handled once');
}

console.log(JSON.stringify({ ...results, fails }, null, 2));
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
