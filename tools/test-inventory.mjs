// Verifies the inventory (issue #74): the panel, the three gear slots, and the
// four things a player can do to something they own.
//
// Usage: bun tools/test-inventory.mjs      (dev server must be up)
//        ...or as sections inside `bun tools/suite.mjs` — same code either way.
//
// FAST-FORWARDED, SHARED-SESSION: every settle that used to be a fixed sleep is
// simulated time through `__dbgAdvance` (see tools/suite/harness.mjs) or a wait
// on STATE — a panel's model, a portrait count, a slot appearing in the DOM.
// The one genuinely real-time thing here is the portrait bake (the stage bakes
// one per RENDERED frame), and that is waited on by counting portraits, not by
// a clock. Measured declared sleeps before the conversion: ~23 s, plus boot.
//
// ORDER, on a shared page: the `start` section asserts the STARTING KIT, so
// this module must run before any module that gives, drops or salvages items —
// and it leaves the bag richer than it found it (see `cleanup`, which reports
// exactly what).
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
// worked on everything would pass every assertion above — the `quest` section
// is what says the refusal is a rule rather than an accident of which items
// were held.
//
// Exits non-zero on failure.

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

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

const inv = (ctx) => ctx.ev(() => window.__dbgInventory());
const act = (ctx, id, action) => ctx.ev((a, b) => window.__dbgInvAction(a, b), id, action);
const give = (ctx, id, n) => ctx.ev((a, b) => window.__dbgGive?.(a, b), id, n);
const pos = (ctx) => ctx.ev(() => window.__dbgPlayerPos());
const ground = (ctx) => ctx.ev(() => window.__dbgFetch().drops);

/**
 * `I` is FRAME-side (takePress in main.ts's frame()), so the press must see a
 * real frame before any advance clears the edge — and the next section's key
 * presses must not land while the panel is mid-close (the modal branch in
 * simulate() would spend them on it), so both helpers settle on the MODEL.
 */
async function openPanel(ctx) {
  if ((await inv(ctx)).open) return;
  await ctx.page.keyboard.press('KeyI');
  await ctx.frame();
  await ctx.waitFn(() => window.__dbgInventory().open, 5000).catch(() => {});
}
async function closePanel(ctx) {
  if (!(await inv(ctx)).open) return;
  await ctx.page.keyboard.press('KeyI');
  await ctx.frame();
  await ctx.waitFn(() => !window.__dbgInventory().open, 5000).catch(() => {});
}

/** Set by `start`; the boot-time snapshot every later section compares against. */
let boot = null;
/** Where this module put items on the ground, so `cleanup` can go collect them. */
const dropSites = [];

export const name = 'inventory';
export const sections = [

  // ---------- 1. the starting kit, and the loadout it implies ----------
  { id: 'start', run: async (ctx) => {
    boot = await inv(ctx);
    if (!boot) throw new Error('__dbgInventory is not there — nothing below can run');
    const kinds = Object.fromEntries(boot.bag.map((e) => [e.id, e]));
    ctx.res.start = {
      bag: boot.bag,
      weapon: boot.weapon,
      baseAttack: boot.baseAttack,
      attackStat: boot.attackStat,
      gear: boot.gear,
      beastRows: boot.entries.filter((e) => e.kind === 'beast').length,
    };
    ctx.check(!!kinds['sword-iron'], 'no starting weapon in the bag');
    ctx.check(!!kinds['potion-mend'], 'no starting potion in the bag');
    ctx.check(!!kinds['bp-dagger'], 'no starting blueprint in the bag');
    // The gear slot is doing something, which is the one claim the picture cannot
    // make: base 14, iron sword +4.
    ctx.check(boot.attackStat === boot.baseAttack + 4,
      `attackStat ${boot.attackStat} is not base ${boot.baseAttack} + the sword's 4`);
    ctx.check(boot.gear.find((g) => g.slot === 'weapon')?.id === 'sword-iron',
      'the weapon slot does not hold the starting sword');
    // Beasts are ROSTER-DERIVED rows, not bag entries — see BEAST_ID_PREFIX. The
    // whole roster of them, and none of them in the bag.
    ctx.check(ctx.res.start.beastRows === ROSTER,
      `${ctx.res.start.beastRows} beast rows, expected the whole roster of ${ROSTER}`);
    ctx.check(!boot.bag.some((e) => e.id.startsWith('beast:')),
      'a beast is stored in the bag — it must be derived from the roster');
    const gearBeasts = boot.gear.filter((g) => g.slot !== 'weapon').map((g) => g.id);
    ctx.check(gearBeasts.every((id) => id && id.startsWith('beast:')),
      `the two beast slots are not filled: ${JSON.stringify(gearBeasts)}`);
  } },

  // ---------- 2. `I` opens it, AND the hero is frozen behind it ----------
  // The pair. `travel` with the panel up must be 0, and the identical hold with it
  // down must move him — otherwise "0" is a hero who could not walk anyway.
  { id: 'modal', run: async (ctx) => {
    // The hold is SIMULATED: a held key stays held through `adv`, and the modal
    // branch freezes the hero in exactly those slices — which is the claim.
    const hold = async (simS) => {
      const a = await pos(ctx);
      await ctx.page.keyboard.down('KeyW');
      await ctx.adv(simS);
      await ctx.page.keyboard.up('KeyW');
      await ctx.adv(0.12);
      return dist(a, await pos(ctx));
    };

    await ctx.page.keyboard.press('KeyI');
    await ctx.frame();
    const open = await inv(ctx);
    const travelOpen = await hold(1.2);
    // The stage bakes one portrait per RENDERED frame (see
    // InventoryStage.iconFor), so this is genuinely real-time — but it is
    // waited on by counting portraits, not by the old fixed 1.2 s sleep.
    let baked = await inv(ctx);
    for (let i = 0; i < 300 && (baked.panel?.portraits ?? 0) < ROSTER; i++) {
      await ctx.frame();
      baked = await inv(ctx);
    }

    await ctx.page.keyboard.press('KeyI');
    await ctx.frame();
    const shut = await inv(ctx);
    // Aimed along the hero's OWN heading first: the opening pose puts the camera
    // in FRONT of him and `KeyW` follows the camera, so a walk from the fire runs
    // into a hut wall two units on. See the playerStart note in AGENTS.md.
    await ctx.page.mouse.move(640, 400);
    await ctx.ev(() => window.__dbgTp?.(
      window.__dbgTowns().spawn.x, window.__dbgTowns().spawn.z,
    ));
    // Drain the streamer the teleport armed, then let the camera's smoothed
    // position arrive — the same settle the old 900 ms sleep was buying.
    await ctx.settleStreaming(20);
    await ctx.adv(0.9);
    const travelShut = await hold(1.2);

    ctx.res.modal = {
      openedByKey: open.open,
      closedByKey: !shut.open,
      panel: open.panel,
      portraitsBaked: baked.panel?.portraits ?? null,
      travelWithPanelUp: +travelOpen.toFixed(2),
      travelWithPanelDown: +travelShut.toFixed(2),
    };
    ctx.check(open.open === true, 'I did not open the inventory');
    ctx.check(shut.open === false, 'I did not close the inventory again');
    ctx.check(travelOpen < 0.5,
      `the hero travelled ${travelOpen.toFixed(2)} with the panel up — it must be a modal`);
    ctx.check(travelShut > 3,
      `the hero travelled only ${travelShut.toFixed(2)} with the panel down — `
      + 'the frozen reading above proves nothing');
    // The panel drew what the model holds: every beast plus the three starting
    // items, FILLED, inside a fixed 11x3 wall of thirty-three, three gear slots,
    // seven tabs. Both numbers, because the wall's shape is the feature — a grid
    // that shrank to what you happen to own is the thing INV_COLS exists to
    // prevent, and a roster that outgrew the wall is the other way it breaks.
    ctx.check(open.panel?.filled === ROSTER + 3,
      `${open.panel?.filled} filled cells, expected ${ROSTER + 3}`);
    ctx.check(open.panel?.slots === 33,
      `${open.panel?.slots} cells drawn, expected a fixed 11x3 of 33`);
    ctx.check(open.panel?.gearSlots === 3,
      `${open.panel?.gearSlots} gear slots drawn, expected 3`);
    ctx.check(open.panel?.tabs === 7, `${open.panel?.tabs} tabs drawn, expected 7`);
    // Two ATLAS icons is the weapon and the blueprint, and it is the only thing
    // that can catch a broken sprite sheet — a slot whose background failed to
    // load renders perfectly and looks like a slot.
    ctx.check((open.panel?.icons ?? 0) >= 2,
      `${open.panel?.icons} atlas icons drawn — the weapon and the blueprint both have one`);
    // THE 3D HALF. `stageGl` says the second WebGL context came up at all;
    // `portraits` says it rendered a distinct beast INTO every wall slot, which is
    // the feature — a slot showing its element lozenge is what this looked like
    // before, and it looks perfectly fine.
    ctx.check(open.panel?.stageGl === true, 'no stage canvas in the panel');
    ctx.check((baked.panel?.portraits ?? 0) === ROSTER,
      `${baked.panel?.portraits} beast portraits baked, `
      + `expected the roster's ${ROSTER}`);
  } },

  // ---------- 2b. the tooltip, and the detail pane's absence ----------
  // The tooltip is the description now, so it has to be asserted on TEXT: an
  // empty box that opens on hover would pass any "is it visible" test.
  { id: 'tooltip', run: async (ctx) => {
    await openPanel(ctx);
    // `page.hover`, not `mouse.move` to the slot's centre: a bare CDP mouse move
    // does not make the browser synthesise the pointerover this listens for, and
    // the version of this section that used one read a null tooltip against a
    // panel that was working perfectly in the hand.
    await ctx.page.hover('.bs-inv .slot[data-sel="potion-mend"]');
    await ctx.waitFn(() => window.__dbgInventory().panel?.tip != null, 5000).catch(() => {});
    const hovered = await inv(ctx);
    const tipBox = await ctx.ev(() => {
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
    await ctx.page.hover('.bs-inv .head h2');
    await ctx.waitFn(() => window.__dbgInventory().panel?.tip == null, 5000).catch(() => {});
    const away = await inv(ctx);

    ctx.res.tooltip = {
      text: hovered.panel?.tip,
      box: tipBox,
      goneOnLeave: away.panel?.tip === null,
      detailPanes: await ctx.ev(() => document.querySelectorAll('.bs-inv .detail').length),
    };
    ctx.check(!!hovered.panel?.tip && hovered.panel.tip.includes('Mending'),
      `the tooltip reads ${JSON.stringify(hovered.panel?.tip)} — it should name the item`);
    ctx.check(hovered.panel.tip.includes('Restores'),
      'the tooltip carries no stats — it replaced a pane that did');
    // CLAMPED INTO THE WINDOW. The dock is against the right edge, so every slot
    // is within a tooltip's width of it: unclamped, this is the assertion that
    // fails, and it fails off screen where nobody sees it.
    ctx.check(tipBox.inFrame, `the tooltip is outside the window: ${JSON.stringify(tipBox)}`);
    ctx.check(ctx.res.tooltip.goneOnLeave, 'the tooltip stayed up after the pointer left');
    ctx.check(ctx.res.tooltip.detailPanes === 0, 'a detail pane is still in the markup');
  } },

  // ---------- 3. equip and unequip move the stat ----------
  { id: 'equip', run: async (ctx) => {
    const before = await inv(ctx);
    await act(ctx, 'sword-iron', 'unequip');
    const bare = await inv(ctx);
    await act(ctx, 'sword-iron', 'equip');
    const armed = await inv(ctx);
    ctx.res.equip = {
      equipped: before.attackStat,
      bare: bare.attackStat,
      reEquipped: armed.attackStat,
      bareGear: bare.gear.find((g) => g.slot === 'weapon')?.id ?? null,
    };
    ctx.check(bare.attackStat === bare.baseAttack,
      `unequipped, attackStat is ${bare.attackStat} and should be the base ${bare.baseAttack}`);
    ctx.check(bare.weapon === null && ctx.res.equip.bareGear === null,
      'the weapon slot still holds something after unequip');
    ctx.check(armed.attackStat === before.attackStat,
      `re-equipping gave ${armed.attackStat}, not the ${before.attackStat} it started at`);
    // An EQUIPPED weapon may not be destroyed out from under the gear slot.
    const row = armed.entries.find((e) => e.id === 'sword-iron');
    ctx.check(!row.actions.includes('drop') && !row.actions.includes('salvage'),
      `the equipped sword still offers ${JSON.stringify(row.actions)}`);
  } },

  // ---------- 3b. right-click runs the row's primary action ----------
  // A PAIR, and it has to be: "right-click unequipped it" is equally true of a
  // working primary action and of a handler wired to `unequip` whatever it is
  // looking at. The same gesture on the same slot has to put it back.
  { id: 'rightClick', run: async (ctx) => {
    const rmb = (sel) => ctx.ev((s) => {
      const el = document.querySelector(`.bs-inv .slot[data-sel="${s}"]`);
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    }, sel);

    const before = await inv(ctx);
    await rmb('sword-iron');
    await ctx.frame();
    const off = await inv(ctx);
    await rmb('sword-iron');
    await ctx.frame();
    const on = await inv(ctx);

    ctx.res.rightClick = {
      startedEquipped: before.weapon,
      afterFirst: off.weapon,
      afterSecond: on.weapon,
      attackAfterFirst: off.attackStat,
      attackAfterSecond: on.attackStat,
    };
    ctx.check(before.weapon === 'sword-iron', 'section 3b did not start with the sword equipped');
    ctx.check(off.weapon === null,
      `right-click left the weapon as ${off.weapon} — its primary action is unequip`);
    ctx.check(on.weapon === 'sword-iron',
      `the second right-click left ${on.weapon} — it should have put the sword back`);
    ctx.check(on.attackStat === before.attackStat,
      `attackStat ended at ${on.attackStat}, not the ${before.attackStat} it started at`);
  } },

  // ---------- 3c. drag onto a gear slot, and off the panel ----------
  // The gestures, through real DragEvents with a real DataTransfer — synthetic,
  // because CDP cannot drive an HTML5 drag, but through the SAME listeners a
  // mouse reaches: the panel reads `event.target` and its own `dragging` id and
  // nothing else.
  { id: 'drag', run: async (ctx) => {
    const drag = (fromSel, toSel) => ctx.ev((f, t) => {
      const dt = new DataTransfer();
      const src = document.querySelector(f);
      const dst = document.querySelector(t);
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    }, fromSel, toSel);

    await give(ctx, 'greatsword-iron', 1);
    // The gift has to be IN THE DOM before a drag can start from its slot.
    await ctx.waitFn(
      () => !!document.querySelector('.bs-inv .slot[data-sel="greatsword-iron"]'), 5000);

    // A weapon onto the WEAPON slot: equip.
    await drag('.bs-inv .slot[data-sel="greatsword-iron"]', '.bs-inv .gs[data-gear="weapon"]');
    await ctx.frame();
    const equipped = await inv(ctx);

    // A POTION onto the weapon slot: refused, and refused by the PANEL — the host
    // never hears about it, because the host never listed `equip` for a potion.
    // Without this the drag half passes for a panel that sends every drop.
    await drag('.bs-inv .slot[data-sel="potion-mend"]', '.bs-inv .gs[data-gear="weapon"]');
    await ctx.frame();
    const stillArmed = await inv(ctx);

    // A benched beast onto the LEAD slot.
    const benched = equipped.entries.find((e) => e.kind === 'beast' && !e.equipped);
    await drag(`.bs-inv .slot[data-sel="${benched.id}"]`, '.bs-inv .gs[data-gear="primary"]');
    await ctx.frame();
    const led = await inv(ctx);

    // And off the panel entirely, onto the world: drop.
    const heldBefore = led.bag.find((e) => e.id === 'sunberry')?.count ?? 0;
    await give(ctx, 'sunberry', 2);
    await ctx.waitFn(
      () => !!document.querySelector('.bs-inv .slot[data-sel="sunberry"]'), 5000);
    await drag('.bs-inv .slot[data-sel="sunberry"]', '.bs-inv .bs-scrim');
    await ctx.frame();
    await ctx.adv(0.1);
    dropSites.push(await pos(ctx));
    const dropped = await inv(ctx);

    const slotOf = (snap, s) => snap.gear.find((g) => g.slot === s)?.id ?? null;
    ctx.res.drag = {
      ontoWeapon: equipped.weapon,
      potionRefused: stillArmed.weapon,
      ontoLead: slotOf(led, 'primary'),
      wanted: benched.id,
      sunberriesBefore: heldBefore + 2,
      sunberriesAfter: dropped.bag.find((e) => e.id === 'sunberry')?.count ?? 0,
    };
    ctx.check(equipped.weapon === 'greatsword-iron',
      `dragging the greatsword onto the weapon slot left ${equipped.weapon}`);
    ctx.check(stillArmed.weapon === 'greatsword-iron',
      `a potion dropped on the weapon slot changed it to ${stillArmed.weapon} — `
      + 'the slot must refuse what the host never offered');
    ctx.check(slotOf(led, 'primary') === benched.id,
      `dragging ${benched.id} onto the lead slot left ${slotOf(led, 'primary')}`);
    ctx.check(ctx.res.drag.sunberriesAfter === ctx.res.drag.sunberriesBefore - 1,
      `dragging off the panel took the stack ${ctx.res.drag.sunberriesBefore} -> `
      + `${ctx.res.drag.sunberriesAfter}, expected one fewer`);
  } },

  // ---------- 4. using a potion: hp up, stack down, buff on a clock ----------
  { id: 'use', run: async (ctx) => {
    // Hurt him first, or a heal on a full-health hero measures nothing.
    await ctx.ev(() => window.__dbgHurt?.(45));
    await ctx.adv(0.1);
    const hurt = await inv(ctx);
    await act(ctx, 'potion-mend', 'use');
    await ctx.adv(0.1);
    const healed = await inv(ctx);

    await give(ctx, 'potion-fury', 1);
    const gotFury = await inv(ctx);
    await act(ctx, 'potion-fury', 'use');
    await ctx.adv(0.1);
    const furious = await inv(ctx);

    const countOf = (snap, id) => snap.bag.find((e) => e.id === id)?.count ?? 0;
    ctx.res.use = {
      hpBefore: hurt.hp,
      hpAfter: healed.hp,
      potionsBefore: countOf(hurt, 'potion-mend'),
      potionsAfter: countOf(healed, 'potion-mend'),
      furyGiven: countOf(gotFury, 'potion-fury'),
      buff: furious.buff,
      attackWithBuff: furious.attackStat,
    };
    ctx.check(hurt.hp < 100, `the hero is on ${hurt.hp} hp — nothing to heal, section 4 proves nothing`);
    ctx.check(healed.hp > hurt.hp, `hp did not move: ${hurt.hp} -> ${healed.hp}`);
    ctx.check(ctx.res.use.potionsAfter === ctx.res.use.potionsBefore - 1,
      `the stack went ${ctx.res.use.potionsBefore} -> ${ctx.res.use.potionsAfter}, expected one fewer`);
    ctx.check(ctx.res.use.furyGiven === 1, 'the console give of a fury draught did not land');
    ctx.check(furious.buff.attack === 10 && furious.buff.seconds > 0,
      `the buff reads ${JSON.stringify(furious.buff)}, expected +10 on a running clock`);
    // RELATIVE to what he had a moment ago, not to a weapon named here: section
    // 3c leaves whatever it last dragged onto the slot, and an absolute figure
    // makes this section fail on a change three sections above it.
    ctx.check(furious.attackStat === gotFury.attackStat + 10,
      `buffed attackStat is ${furious.attackStat}, expected ${gotFury.attackStat} + the draught's 10`);
  } },

  // ---------- 5. salvage pays, and drop lands on the ground ----------
  { id: 'salvageDrop', run: async (ctx) => {
    const before = await inv(ctx);
    await act(ctx, 'bp-dagger', 'salvage');
    const sold = await inv(ctx);
    ctx.res.salvage = {
      shardsBefore: before.shards,
      shardsAfter: sold.shards,
      gone: !sold.bag.some((e) => e.id === 'bp-dagger'),
    };
    // The dagger blueprint is worth 3 (core/items.ts).
    ctx.check(sold.shards === before.shards + 3,
      `salvage paid ${sold.shards - before.shards}, expected the blueprint's 3`);
    ctx.check(ctx.res.salvage.gone, 'the salvaged blueprint is still in the bag');

    await give(ctx, 'glowpebble', 2);
    const held = await inv(ctx);
    const where = await pos(ctx);
    await act(ctx, 'glowpebble', 'drop');
    await ctx.adv(0.3);
    const dropped = await inv(ctx);
    const onGround = (await ground(ctx)).filter((d) => d.itemId === 'glowpebble');
    dropSites.push(where);
    // AND IT STAYS DROPPED. The hero is standing on top of it; an ARMED drop
    // magnets back inside a third of a second, so the SIMULATED wait is the
    // assertion.
    await ctx.adv(1.6);
    const after = await inv(ctx);

    const countOf = (snap) => snap.bag.find((e) => e.id === 'glowpebble')?.count ?? 0;
    ctx.res.drop = {
      held: countOf(held),
      afterDrop: countOf(dropped),
      onGround: onGround.length,
      stillOutAfter1p6s: countOf(after),
      heroMoved: +dist(where, await pos(ctx)).toFixed(2),
    };
    ctx.check(countOf(dropped) === countOf(held) - 1,
      `the stack went ${countOf(held)} -> ${countOf(dropped)}, expected one fewer`);
    ctx.check(onGround.length >= 1,
      'nothing is on the ground after the drop — Drop must not be Delete');
    ctx.check(countOf(after) === countOf(dropped),
      `the drop came back on its own (${countOf(dropped)} -> ${countOf(after)}) — `
      + 'a fresh drop is unarmed until the player walks away from it');
  } },

  // ---------- 6. the control: a quest item refuses both ----------
  { id: 'quest', run: async (ctx) => {
    await give(ctx, 'gain-token', 1);
    const held = await inv(ctx);
    const row = held.entries.find((e) => e.id === 'gain-token');
    // Ask anyway. The refusal has to be in the HANDLER and not only in which
    // buttons were drawn, or a panel bug is a way to delete a quest item.
    await act(ctx, 'gain-token', 'drop');
    await act(ctx, 'gain-token', 'salvage');
    const after = await inv(ctx);
    ctx.res.quest = {
      actions: row?.actions ?? null,
      countBefore: held.bag.find((e) => e.id === 'gain-token')?.count ?? 0,
      countAfter: after.bag.find((e) => e.id === 'gain-token')?.count ?? 0,
      shardsBefore: held.shards,
      shardsAfter: after.shards,
    };
    ctx.check(!!row, 'the quest item never reached the bag');
    ctx.check(row && row.actions.length === 0,
      `a quest item offers ${JSON.stringify(row?.actions)} — it must offer neither`);
    ctx.check(ctx.res.quest.countAfter === ctx.res.quest.countBefore,
      'a quest item was destroyed by a direct call to the action handler');
    ctx.check(ctx.res.quest.shardsAfter === ctx.res.quest.shardsBefore,
      'salvaging a quest item paid out');
  } },

  // ---------- 7. the beast slots are the SAME two Tab moves ----------
  // Not a second copy of the roster picks: equipping a benched beast from the
  // panel and then pressing Tab has to land where a player expects, which it can
  // only do if both are writing `primaryIdx`/`supportIdx`.
  { id: 'beastSlots', run: async (ctx) => {
    // THE PANEL HAS TO BE SHUT FOR THIS ONE. Tab is read in a simulation slice
    // and every modal in the game freezes those, so a Tab pressed with the
    // inventory up is a Tab the hero never sees — which reads exactly like the
    // failure this section is looking for, and did, for one run.
    await closePanel(ctx);
    const before = await inv(ctx);
    const benched = before.entries.find((e) => e.kind === 'beast' && !e.equipped);
    await act(ctx, benched.id, 'setLead');
    const led = await inv(ctx);
    // Tab is SIM-side, so the advance is what spends the press.
    await ctx.page.keyboard.press('Tab');
    await ctx.adv(0.3);
    const swapped = await inv(ctx);
    const slotOf = (snap, s) => snap.gear.find((g) => g.slot === s)?.id ?? null;
    ctx.res.beastSlots = {
      picked: benched.id,
      afterSetLead: { lead: slotOf(led, 'primary'), support: slotOf(led, 'support') },
      afterTab: { lead: slotOf(swapped, 'primary'), support: slotOf(swapped, 'support') },
    };
    ctx.check(slotOf(led, 'primary') === benched.id,
      `setLead put ${slotOf(led, 'primary')} in front, not ${benched.id}`);
    ctx.check(slotOf(swapped, 'support') === benched.id,
      'Tab did not move the beast the panel had just equipped — the panel is keeping '
      + 'its own copy of the roster picks');
    ctx.check(slotOf(swapped, 'primary') === slotOf(led, 'support'),
      'Tab did not bring the support beast to the front');
  } },

  // ---------- 9. the stage survives a swap ----------
  // THE REPORTED BUG. Sending a beast that is already in one slot to the OTHER
  // one is a swap, and the stage used to fill its two marks one at a time:
  // slot 0 took the support beast's rig, then slot 1's turn removed "whatever
  // used to be in slot 1" — the same rig, one line later. One of the two beasts
  // simply vanished from the preview and stayed gone.
  //
  // It is asserted on what is IN THE SCENE (`stageCast`) rather than on what the
  // panel asked for, because those are exactly the two things that disagreed.
  { id: 'stageSwap', run: async (ctx) => {
    await openPanel(ctx);
    const idOf = (s) => s.replace('beast:', '');
    const before = await inv(ctx);
    const lead = before.gear.find((g) => g.slot === 'primary').id;
    const support = before.gear.find((g) => g.slot === 'support').id;

    // Send the SUPPORT beast to the front — a swap, and the failing case. The
    // stage repopulates on the next RENDERED frame, so it gets two.
    await act(ctx, support, 'setLead');
    await ctx.frame();
    await ctx.frame();
    const swapped = await inv(ctx);
    // And back, so the pair is closed and a one-way fluke cannot pass.
    await act(ctx, lead, 'setLead');
    await ctx.frame();
    await ctx.frame();
    const back = await inv(ctx);

    ctx.res.stageSwap = {
      startCast: before.panel?.stageCast,
      afterSwap: swapped.panel?.stageCast,
      afterSwapBack: back.panel?.stageCast,
      gearAfterSwap: swapped.gear.map((g) => g.id),
    };
    const full = (c) => Array.isArray(c) && c.length === 2 && c.every((x) => !!x);
    ctx.check(full(before.panel?.stageCast),
      `the stage started with ${JSON.stringify(before.panel?.stageCast)}, expected two beasts`);
    ctx.check(full(swapped.panel?.stageCast),
      `after a swap the stage holds ${JSON.stringify(swapped.panel?.stageCast)} — `
      + 'one of the two models was removed from the scene');
    ctx.check(full(back.panel?.stageCast),
      `after swapping back the stage holds ${JSON.stringify(back.panel?.stageCast)}`);
    // ...and it is drawing the beasts the GEAR SLOTS name, in that order, rather
    // than merely two of something.
    ctx.check(swapped.panel.stageCast[0] === idOf(swapped.gear.find((g) => g.slot === 'primary').id)
      && swapped.panel.stageCast[1] === idOf(swapped.gear.find((g) => g.slot === 'support').id),
      'the stage is drawing beasts the gear slots do not name');
  } },

  // ---------- 8. the weapon in his hand, and what it does ----------
  // The gear slot was a NUMBER until the models landed: equipping a scythe raised
  // attackStat and the hero went on swinging an iron sword. So every claim here
  // is about `player.weapon`, which is read off the RIG rather than off a field
  // beside it — there is no second copy that could agree while the model on
  // screen does not.
  { id: 'weapons', run: async (ctx) => {
    const shots = () => ctx.ev(() => window.__dbgShots());
    // A DELTA, not a count. An arrow lives 1.6 s and the pool is shared, so the
    // one fired by the bow is still in the air when the sword swings a moment
    // later — the first version of this section read it as the sword's and
    // failed against a perfectly correct build.
    const swing = async () => {
      const before = (await shots()).shots.filter((s) => s.arrow).length;
      await ctx.page.mouse.down();
      await ctx.adv(0.07);
      await ctx.page.mouse.up();
      await ctx.adv(0.16);
      const after = await shots();
      return { ...after, fired: after.shots.filter((s) => s.arrow).length - before };
    };

    // Somewhere with room, and off the panel: a swing is a simulation slice.
    await closePanel(ctx);
    await ctx.ev(() => window.__dbgTp?.(
      window.__dbgTowns().spawn.x, window.__dbgTowns().spawn.z,
    ));
    await ctx.settleStreaming(20);
    await ctx.adv(0.9);

    const seen = {};
    for (const [item, model] of [
      ['sword-iron', 'sword'], ['greatsword-iron', 'greatsword'],
      ['bow-ash', 'bow'], ['scythe-reaper', 'scythe'], ['dagger-quick', 'dagger'],
    ]) {
      await give(ctx, item, 1);
      await act(ctx, item, 'equip');
      await ctx.adv(0.2);
      seen[item] = (await shots()).weapon;
      ctx.check(seen[item] === model,
        `equipping ${item} left the hero holding ${seen[item]}, expected ${model}`);
    }

    // THE BOW FIRES AN ARROW, and the `arrow` flag is the whole assertion: the
    // projectile pool is shared with every skill in the game, so a bow that came
    // out as a fireball would look identical in a count and in a screenshot.
    await act(ctx, 'bow-ash', 'equip');
    await ctx.adv(0.2);
    const fired = await swing();
    const arrows = fired.shots.filter((s) => s.arrow);

    // ...and a MELEE weapon does not. The pair: "an arrow appeared" is equally
    // true of a bow and of a build where every swing spawns one.
    await act(ctx, 'sword-iron', 'equip');
    await ctx.adv(0.2);
    const swung = await swing();

    // BARE HANDS. Unequipping leaves the hand empty, which is what puts the
    // animator on the punch table (PUNCHES, player/animations.ts) — the poses
    // themselves are not something a probe can see, so what is asserted is the
    // one input that selects them, plus the stat falling back to the base.
    await act(ctx, 'sword-iron', 'unequip');
    await ctx.adv(0.2);
    const bare = await shots();
    const punched = await swing();

    ctx.res.weapons = {
      equipped: seen,
      bowShots: fired.fired,
      bowShotSpeed: arrows[0]?.speed ?? null,
      swordShots: swung.fired,
      bareWeapon: bare.weapon,
      bareAttack: bare.attackStat,
      bareShots: punched.fired,
    };
    ctx.check(fired.fired >= 1, 'the bow fired nothing');
    ctx.check((arrows[0]?.speed ?? 0) > 8,
      `the arrow is travelling at ${arrows[0]?.speed} — it should be in flight, not parked`);
    ctx.check(ctx.res.weapons.swordShots === 0,
      'a sword swing fired an arrow — only the bow may');
    ctx.check(bare.weapon === null, `unequipping left ${bare.weapon} in his hand`);
    ctx.check(ctx.res.weapons.bareShots === 0, 'bare hands fired an arrow');
  } },

  // ---------- 10. Escape closes the inventory and NOTHING ELSE ----------
  // THE REPORTED BUG, and it is not double-handling of the key — the cancel
  // branch in main.ts already routes one press to one panel. It was the POINTER
  // LOCK, and the same 8 ms hazard ui/pause.ts documents at length:
  //
  //   Escape (no keyboard lock) -> the panel closes -> its onClose re-takes the
  //   lock -> the browser's own fullscreen exit, from that SAME key, drops the
  //   lock a few milliseconds later -> Input.onLockLost read a lock that was
  //   TAKEN and tapped a virtual Escape -> the next frame had no modal up, so the
  //   in-game menu opened.
  //
  // The last two steps are gone with the move to F10: losing the pointer no longer
  // manufactures a key at all (see arm 1b of tools/test-pause.mjs). This section
  // still drives the same sequence, because the ORDER is what it guards — one
  // press must close one panel and leave the menu shut, however the lock behaves
  // around it. The lock going away is driven from the page
  // (`document.exitPointerLock`) because that is precisely what the browser does
  // to it, and because CDP cannot make a synthetic Escape release a real lock.
  //
  // The pair's second half is now F10: the menu must still be REACHABLE with
  // nothing open, or this passes against a build where the menu key is dead.
  { id: 'escapeRouting', run: async (ctx) => {
    const menuOpen = () => ctx.ev(() => !!document.querySelector('.bs-pause'));
    const closeAll = async () => {
      await ctx.ev(() => {
        document.querySelector('.bs-pause [data-act="continue"]')?.click();
      });
      await ctx.frame();
      await closePanel(ctx);
    };
    // The lock is granted (and lost) on REAL browser events, so both are waited
    // on as STATE — pointerLockElement — rather than slept for.
    const takeLock = async () => {
      await ctx.page.mouse.click(300, 400);
      await ctx.waitFn(() => !!document.pointerLockElement, 3000).catch(() => {});
    };
    const loseLock = async () => {
      await ctx.ev(() => document.exitPointerLock());
      await ctx.waitFn(() => !document.pointerLockElement, 3000).catch(() => {});
      // ...and let the game's frame and a few sim slices react (or, correctly,
      // not react) to the loss before the menu is read.
      await ctx.frame();
      await ctx.adv(0.4);
    };

    await closeAll();
    // A real click, so the page is actually holding a lock to lose.
    await takeLock();

    await ctx.page.keyboard.press('KeyI');
    await ctx.frame();
    const opened = (await inv(ctx)).open;
    // Escape is SIM-side: the advance is what routes it to the cancel branch.
    await ctx.page.keyboard.press('Escape');
    await ctx.adv(0.25);
    const closed = !(await inv(ctx)).open;
    // ...and now the browser takes the pointer back, on the same key.
    await loseLock();
    const menuAfterEscape = await menuOpen();

    await closeAll();
    // A LOCK TAKEN WITH NOTHING OPEN RAISES NOTHING. This used to be the control
    // and it is now an assertion in its own right: the menu came from a stolen
    // pointer while it lived on Escape, and it must not any more.
    await takeLock();
    await loseLock();
    const menuFromBareLoss = await menuOpen();

    // THE CONTROL, in its new form: the menu key still works with nothing open.
    // Without this the two assertions above pass against a build whose menu can
    // never be opened at all.
    await ctx.page.keyboard.press('F10');
    await ctx.adv(0.4);
    await ctx.frame();
    const menuFromF10 = await menuOpen();
    await closeAll();

    ctx.res.escape = {
      openedByI: opened,
      closedByEscape: closed,
      menuAfterEscape,
      menuFromBareLoss,
      menuFromF10,
    };
    ctx.check(opened, 'I did not open the panel for section 10');
    ctx.check(closed, 'Escape did not close the inventory');
    ctx.check(menuAfterEscape === false,
      'Escape closed the inventory AND opened the in-game menu — the panel must '
      + 'spend that press, and its onClose must not re-take a lock the browser is '
      + 'about to knock out');
    ctx.check(menuFromBareLoss === false,
      'a pointer lock taken with nothing open raised the in-game menu — losing the '
      + 'mouse is not a request for a menu');
    ctx.check(menuFromF10 === true,
      'F10 did not open the menu — the assertions above are passing because the '
      + 'menu is unreachable, not because the routing is right');
  } },

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
  // A PAIR: Escape must close the den AND leave the menu shut, and the MENU KEY
  // with nothing open must still raise the menu — otherwise this passes against a
  // build where Escape does nothing at all. (That second half was Escape too,
  // until the menu moved to F10.)
  { id: 'denRouting', run: async (ctx) => {
    const menuOpen = () => ctx.ev(() => !!document.querySelector('.bs-pause'));
    const shopOpen = () => ctx.ev(() => !!document.querySelector('.bs-shopwrap.open'));
    const shut = async () => {
      await ctx.ev(() => {
        document.querySelector('.bs-pause [data-act="continue"]')?.click();
      });
      await ctx.frame();
      await closePanel(ctx);
    };

    await shut();
    // Stand at a den. `__dbgShops` reports where they were sited, so nothing here
    // pins a coordinate to a seed.
    // IN FRONT OF IT, not on it. `facing` is the bearing from the den toward the
    // spawn (see __dbgShops), which is the side its counter is on, and standing
    // ON the den lands the hero inside a solid building — the dens grew colliders
    // when the settlements did. 2.6 units out is inside `nearShop`'s 3.5.
    const den = (await ctx.ev(() => window.__dbgShops()))[0];
    await ctx.ev(
      (x, z, f) => window.__dbgTp(x + Math.sin(f) * 2.6, z + Math.cos(f) * 2.6),
      den.x, den.z, den.facing,
    );
    await ctx.settleStreaming(20);
    await ctx.adv(0.6);
    // A real click first, so the page is holding the pointer lock the den is
    // about to hand back — which is the state a player is always in.
    await ctx.page.mouse.click(400, 400);
    await ctx.waitFn(() => !!document.pointerLockElement, 3000).catch(() => {});

    // E and Escape are both SIM-side; each advance spends its press.
    await ctx.page.keyboard.press('KeyE');
    await ctx.adv(0.5);
    await ctx.frame();
    const openedByE = await shopOpen();
    await ctx.page.keyboard.press('Escape');
    await ctx.adv(0.5);
    await ctx.frame();
    const closedByEscape = !(await shopOpen());
    const menuAfterEscape = await menuOpen();
    await shut();

    // THE CONTROL: with nothing open, F10 is the menu key and must work.
    await ctx.page.keyboard.press('F10');
    await ctx.adv(0.4);
    await ctx.frame();
    const menuFromBareEscape = await menuOpen();
    await shut();

    ctx.res.den = {
      at: { x: den.x, z: den.z },
      openedByE,
      closedByEscape,
      menuAfterEscape,
      menuFromBareEscape,
    };
    ctx.check(openedByE, 'E did not open the skill den — nothing below this means anything');
    ctx.check(closedByEscape, 'Escape did not close the skill den');
    ctx.check(menuAfterEscape === false,
      'Escape closed the skill den AND opened the in-game menu — the shop must not '
      + 'have a keyboard path of its own, or the slice sees no modal and opens the menu');
    ctx.check(menuFromBareEscape === true,
      'F10 with nothing open did not open the menu — the assertion above is '
      + 'passing because the key is dead, not because it is handled once');
  } },

  // ---------- 12. hand the page back ----------
  // A SHARED page inherits this module's leavings, so what can be undone is
  // undone here and what cannot is REPORTED in `res.cleanup` (no assertions —
  // this section is housekeeping, not a claim about the game):
  //
  //   * the fury buff is burned off in simulated time;
  //   * the starting sword goes back in his hand;
  //   * the beast slots are steered back toward the boot loadout with the same
  //     `setLead` the sections used (best effort — there is no setSupport);
  //   * the ground drops are collected by arming them (walk-away distance) and
  //     standing on them again;
  //   * what remains — the given weapons, the sunberry, the quest token, the
  //     spent potions and blueprint, any hp shortfall — is listed, because the
  //     bag cannot be un-given without a delete this module exists to forbid.
  { id: 'cleanup', run: async (ctx) => {
    await ctx.ev(() => {
      document.querySelector('.bs-pause [data-act="continue"]')?.click();
    });
    await ctx.frame();
    await closePanel(ctx);

    // Burn the fury buff off in simulated time, so the next module's attack
    // stat is not +10 for a while.
    const buff = (await inv(ctx)).buff;
    if (buff && buff.seconds > 0 && buff.seconds < 300) {
      await ctx.adv(Math.min(buff.seconds + 1, 300));
    }

    // The starting weapon back in his hand.
    await act(ctx, 'sword-iron', 'equip');

    // Best-effort restore of the boot beast loadout: setLead the boot support
    // first, then the boot lead — if the lead was sitting in support, the
    // second call is the swap that puts both back.
    const wantLead = boot?.gear.find((g) => g.slot === 'primary')?.id;
    const wantSupport = boot?.gear.find((g) => g.slot === 'support')?.id;
    if (wantLead && wantSupport) {
      await act(ctx, wantSupport, 'setLead');
      await act(ctx, wantLead, 'setLead');
    }

    // Collect the drops: teleport out past the arming distance, then back onto
    // each site so the magnet takes them.
    for (const site of dropSites) {
      await ctx.tp(site.x + 40, site.z);
      await ctx.adv(1);
      await ctx.tp(site.x, site.z);
      await ctx.adv(2);
    }
    // ...and leave the hero somewhere every module knows: the spawn.
    await ctx.ev(() => window.__dbgTp?.(
      window.__dbgTowns().spawn.x, window.__dbgTowns().spawn.z,
    ));
    await ctx.settleStreaming(20);

    const end = await inv(ctx);
    const bootCounts = new Map((boot?.bag ?? []).map((e) => [e.id, e.count]));
    ctx.res.cleanup = {
      groundLeft: (await ground(ctx)).map((d) => d.itemId),
      bagChanged: end.bag
        .filter((e) => e.count !== (bootCounts.get(e.id) ?? 0))
        .map((e) => ({ id: e.id, was: bootCounts.get(e.id) ?? 0, now: e.count }))
        .concat((boot?.bag ?? [])
          .filter((e) => !end.bag.some((x) => x.id === e.id))
          .map((e) => ({ id: e.id, was: e.count, now: 0 }))),
      gear: end.gear.map((g) => `${g.slot}:${g.id}`),
      hp: end.hp,
      buff: end.buff,
    };
  } },
];

if (import.meta.main) {
  const { soloRun } = await import('./suite/harness.mjs');
  await soloRun({ name, sections });
}
