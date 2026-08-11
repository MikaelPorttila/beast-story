// Verifies that a character survives being written down: the round trip, what
// happens to a save whose content has been removed from under it, where a hero
// lands when the ground he saved on is gone, and that two characters are two
// characters.
//
// Usage: bun tools/test-saves.mjs        (dev server must be up)
//
// THE ONE PROBE THAT BOOTS WITHOUT `nostore=1`. Every other tool in here passes
// it (see BOOT_QUERY in tools/suite/harness.mjs) precisely so they leave no
// records behind and take no autosave inside a measurement; this file is
// testing the store, so it has to let the store exist.
//
// A FRESH BROWSER CONTEXT PER CASE, which is what makes these independent. A
// context is its own storage partition, so each case starts with an empty
// IndexedDB and cannot see the characters another one wrote — the same
// isolation tools/test-settings.mjs gets for localStorage, and the reason no
// case here has to clean up after itself.
//
// WHAT IT ASSERTS ON. Not "the hook returned something": the readings are the
// hero's position, the bag's contents, a beast's level and the content flags,
// each read back through the hook that the game itself derives from. A save
// that wrote a field and a load that ignored it would pass a test of the
// document and fail every one of these.
//
// Exits non-zero.
import { launchBrowser, leaveSplash, newContextPage, whenPlaying } from './browser.mjs';
import { BASE as HOST, NO_WARMUP } from './target.mjs';

const browser = await launchBrowser();
const out = {};
const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); };

// NO_WARMUP: nothing here times a frame. Every reading is state — a position, a
// count, a level — and the shader sweep changes none of it.
const URL = `${HOST}/?menu=0&fs=0&vol=0&${NO_WARMUP}`;

async function boot() {
  const { ctx, page } = await newContextPage(browser, { width: 900, height: 600 });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await whenPlaying(page);
  return { ctx, page };
}

/** Everything a case compares, in one round trip through the page. */
const readState = (page) => page.evaluate(() => {
  const doc = window.__dbgSaves.doc();
  const pos = window.__dbgPlayerPos();
  return {
    pos: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) },
    bag: Object.fromEntries(doc.bag),
    beasts: Object.fromEntries(doc.beasts.map((b) => [b.speciesId, b.level])),
    party: doc.party,
    currency: doc.currency,
    name: doc.name,
    zoneId: doc.location.zoneId,
  };
});

// ---------------------------------------------------------------------------
// 1. The round trip: change things, save, change them back, load, compare.
// ---------------------------------------------------------------------------
{
  const { ctx, page } = await boot();
  const available = await page.evaluate(() => window.__dbgSaves.available());
  check(available, 'the store reports itself unavailable on a plain boot');

  // Something in every category the document carries, so a field dropped by
  // either half of the trip shows up as a difference rather than as nothing.
  await page.evaluate(() => {
    window.__dbgGive('sunberry', 7);
    window.__dbgGrantBeast('emberfox');
    window.__dbgTp(140, -60);
  });
  const saved = await readState(page);
  const id = await page.evaluate(() => window.__dbgSaves.save('Probe'));
  check(typeof id === 'number' && id > 0, `save() returned ${JSON.stringify(id)}`);
  out.roundtrip = { id, saved };

  // Now make the session deliberately WRONG in every one of those places.
  await page.evaluate(() => {
    window.__dbgGive('sunberry', 5);
    window.__dbgTp(-300, 400);
    window.__dbgSaves.save;   // no-op read: the perturbation must not itself save
  });
  const perturbed = await readState(page);
  check(perturbed.bag.sunberry !== saved.bag.sunberry, 'the perturbation changed nothing to load over');

  const loaded = await page.evaluate((n) => window.__dbgSaves.load(n), id);
  check(loaded === true, 'load() refused the id save() had just returned');
  const back = await readState(page);
  out.roundtrip.back = back;

  check(back.name === 'Probe', `the name did not survive: ${back.name}`);
  check(back.bag.sunberry === saved.bag.sunberry,
    `sunberries: saved ${saved.bag.sunberry}, loaded ${back.bag.sunberry}`);
  check(back.beasts.emberfox === saved.beasts.emberfox,
    `the emberfox came back at level ${back.beasts.emberfox}, saved at ${saved.beasts.emberfox}`);
  check(back.party.primary === saved.party.primary,
    `the party lead changed: ${saved.party.primary} -> ${back.party.primary}`);
  check(back.currency === saved.currency,
    `the purse changed: ${saved.currency} -> ${back.currency}`);
  // Within a unit: the position is re-grounded on the way in, and the ground
  // under a point is the same ground it was.
  check(Math.abs(back.pos.x - saved.pos.x) <= 1 && Math.abs(back.pos.z - saved.pos.z) <= 1,
    `the hero came back at ${JSON.stringify(back.pos)}, saved at ${JSON.stringify(saved.pos)}`);

  await ctx.close();
}

// ---------------------------------------------------------------------------
// 2. A save whose content has been removed: the unknown item is dropped and
//    everything beside it survives. The document is rewritten in the database
//    directly, which is the only way to produce a save this build cannot
//    fully resolve without deleting an item from the build.
// ---------------------------------------------------------------------------
{
  const { ctx, page } = await boot();
  await page.evaluate(() => {
    window.__dbgGive('sunberry', 3);
    window.__dbgGive('glowpebble', 2);
  });
  const id = await page.evaluate(() => window.__dbgSaves.save('Ghost'));

  // Straight into IndexedDB, past the game: put an item nothing ships into the
  // bag of a document the game wrote.
  const injected = await page.evaluate((n) => new Promise((resolve, reject) => {
    const open = indexedDB.open('beast-story-saves');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('payloads', 'readwrite');
      const store = tx.objectStore('payloads');
      const get = store.get(n);
      get.onsuccess = () => {
        const row = get.result;
        row.doc.bag = [['sunberry', 3], ['no-such-item', 9], ['glowpebble', 2]];
        store.put(row);
      };
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => reject(tx.error);
    };
  }), id);
  check(injected === true, 'could not stage the doctored document');

  const loaded = await page.evaluate((n) => window.__dbgSaves.load(n), id);
  check(loaded === true, 'the doctored save would not load at all');
  const state = await readState(page);
  out.unknownItem = { bag: state.bag };
  check(state.bag['no-such-item'] === undefined,
    'an item this build does not ship survived the load');
  check(state.bag.sunberry === 3 && state.bag.glowpebble === 2,
    `the items beside it did not survive: ${JSON.stringify(state.bag)}`);

  await ctx.close();
}

// ---------------------------------------------------------------------------
// 3. A save whose PLACE is gone: an unknown zone and an unusable coordinate.
//    The character must still load, standing on ground, in a zone that exists.
// ---------------------------------------------------------------------------
{
  const { ctx, page } = await boot();
  const id = await page.evaluate(() => window.__dbgSaves.save('Lost'));
  const staged = await page.evaluate((n) => new Promise((resolve, reject) => {
    const open = indexedDB.open('beast-story-saves');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('payloads', 'readwrite');
      const store = tx.objectStore('payloads');
      const get = store.get(n);
      get.onsuccess = () => {
        const row = get.result;
        // A zone that was deleted, and a coordinate that cannot be stood on.
        // `null` rather than NaN: JSON has no NaN, so null is the shape a
        // corrupt number actually arrives in.
        row.doc.location = { zoneId: 'no-such-zone', x: null, y: null, z: null, yaw: 0 };
        store.put(row);
      };
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => reject(tx.error);
    };
  }), id);
  check(staged === true, 'could not stage the lost-location document');

  const loaded = await page.evaluate((n) => window.__dbgSaves.load(n), id);
  check(loaded === true, 'a save with no usable location refused to load');
  const state = await page.evaluate(() => {
    const pos = window.__dbgPlayerPos();
    return {
      pos,
      zone: window.__dbgZone().id,
      // Where the ground actually is under him, so "he is standing on it" is
      // an assertion about the world rather than about the number he carries.
      // `.ground` is the heightfield, which is what the save resolves against;
      // `.surface` is what is DRAWN there and can be a roof.
      surface: window.__dbgSurfaceY(pos.x, pos.z).ground,
    };
  });
  out.lostLocation = {
    zone: state.zone,
    pos: { x: Math.round(state.pos.x), y: Math.round(state.pos.y), z: Math.round(state.pos.z) },
    surface: Math.round(state.surface),
  };
  check(state.zone === 'overworld', `a deleted zone resolved to ${state.zone}`);
  check(Number.isFinite(state.pos.x) && Number.isFinite(state.pos.z),
    `the hero is at ${JSON.stringify(state.pos)}`);
  check(Math.abs(state.pos.y - state.surface) <= 2,
    `the hero is ${(state.pos.y - state.surface).toFixed(1)} units off the ground`);

  await ctx.close();
}

// ---------------------------------------------------------------------------
// 4. Saved in mid-air: the stored position is on the ground under him, not the
//    altitude he was at. This is the half of the location rule a player feels —
//    a save taken on a flying mount must not drop the character on load.
// ---------------------------------------------------------------------------
{
  const { ctx, page } = await boot();
  const air = await page.evaluate(() => {
    const p = window.__dbgPlayerPos();
    // Straight up from where he stands, with the height passed literally.
    window.__dbgTp(p.x, p.z, p.y + 120);
    const lifted = window.__dbgPlayerPos();
    const doc = window.__dbgSaves.doc();
    return {
      lifted: lifted.y,
      stored: doc.location.y,
      surface: window.__dbgSurfaceY(lifted.x, lifted.z).ground,
    };
  });
  out.midAir = {
    lifted: Math.round(air.lifted),
    stored: Math.round(air.stored),
    surface: Math.round(air.surface),
  };
  check(air.lifted - air.surface > 100, `the hero did not actually leave the ground: ${JSON.stringify(out.midAir)}`);
  check(Math.abs(air.stored - air.surface) <= 2,
    `a mid-air save stored y=${air.stored.toFixed(1)} with ground at ${air.surface.toFixed(1)}`);

  await ctx.close();
}

// ---------------------------------------------------------------------------
// 5. Two characters are two characters: both listed, newest first, each
//    loading its own state, and deleting one leaving the other alone.
// ---------------------------------------------------------------------------
{
  const { ctx, page } = await boot();
  const ids = await page.evaluate(async () => {
    window.__dbgGive('sunberry', 2);
    const a = await window.__dbgSaves.save('Ayla');
    // A SECOND CHARACTER, not a second save of the first — `save()` writes
    // whoever is being played, so without this the two calls update one record.
    // This is what New Game leaves behind: a name and no record yet.
    window.__dbgSaves.newCharacter('Bram');
    window.__dbgGive('sunberry', 40);
    // The list is ordered by when a character was last played, and `Date.now()`
    // is millisecond-resolution — two writes inside one tick would tie and make
    // the order below a coin toss. Staging a gap is the assertion's setup, not
    // a wait for the game to settle.
    await new Promise((r) => setTimeout(r, 5));
    const b = await window.__dbgSaves.save();
    return { a, b };
  });
  check(ids.a !== ids.b, `two saves share one id (${ids.a})`);

  const list = await page.evaluate(() => window.__dbgSaves.list());
  out.slots = { ids, list: list.map((r) => ({ id: r.id, name: r.name, power: r.powerLevel })) };
  check(list.length === 2, `expected 2 characters, listed ${list.length}`);
  check(list[0].id === ids.b, 'the list is not most-recently-played first');
  check(list.some((r) => r.name === 'Ayla') && list.some((r) => r.name === 'Bram'),
    `the names did not reach the list: ${JSON.stringify(out.slots.list)}`);
  // The power level is the sum of bonded beast levels, and a new game has one
  // beast at level 1 — so it is 1 rather than 0, which is what says it was
  // derived from the roster and not left at a default.
  check(list.every((r) => r.powerLevel >= 1),
    `a character listed a power level of 0: ${JSON.stringify(out.slots.list)}`);

  await page.evaluate((n) => window.__dbgSaves.load(n), ids.a);
  const asA = await readState(page);
  await page.evaluate((n) => window.__dbgSaves.load(n), ids.b);
  const asB = await readState(page);
  out.slots.bags = { a: asA.bag.sunberry, b: asB.bag.sunberry };
  check(asA.name === 'Ayla' && asB.name === 'Bram',
    `the two characters loaded as ${asA.name} and ${asB.name}`);
  check(asA.bag.sunberry !== asB.bag.sunberry,
    `both characters loaded the same bag: ${JSON.stringify(out.slots.bags)}`);

  await page.evaluate((n) => window.__dbgSaves.del(n), ids.a);
  const after = await page.evaluate(() => window.__dbgSaves.list());
  out.slots.afterDelete = after.map((r) => r.id);
  check(after.length === 1 && after[0].id === ids.b,
    `after deleting one: ${JSON.stringify(out.slots.afterDelete)}`);

  await ctx.close();
}

// ---------------------------------------------------------------------------
// 6. `nostore=1` really stores nothing — the flag every other probe boots with.
// ---------------------------------------------------------------------------
{
  const { ctx, page } = await newContextPage(browser, { width: 900, height: 600 });
  await page.goto(`${URL}&nostore=1`, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await whenPlaying(page);
  const res = await page.evaluate(async () => ({
    available: window.__dbgSaves.available(),
    saved: await window.__dbgSaves.save('Nobody'),
    listed: (await window.__dbgSaves.list()).length,
    // The database itself must not have been created. `databases()` is the
    // only way to ask without creating one by opening it.
    dbs: (await indexedDB.databases()).map((d) => d.name),
  }));
  out.noStore = res;
  check(res.available === false, 'nostore=1 still reports the store available');
  check(res.listed === 0, `nostore=1 listed ${res.listed} characters`);
  check(!res.dbs.includes('beast-story-saves'),
    `nostore=1 created the database anyway: ${JSON.stringify(res.dbs)}`);

  await ctx.close();
}

// ---------------------------------------------------------------------------
// 7. AUTOSAVE, both halves — the timer and the quest trigger.
//
//    `autosaveSec=2` runs the same accumulator through the same comparison in
//    seconds instead of minutes; a probe that waited for the shortest real
//    setting would take a minute, and one that poked the accumulator directly
//    would prove nothing about the path a player is on. Time is SIMULATED
//    through __dbgAdvance, so neither half of this waits on a wall clock.
// ---------------------------------------------------------------------------
{
  const { ctx, page } = await newContextPage(browser, { width: 900, height: 600 });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(`${URL}&autosaveSec=2`, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await whenPlaying(page);

  const armed = await page.evaluate(() => window.__dbgSaves.autosave());
  out.autosave = { armed };
  check(armed.periodSec === 2, `the interval override did not take: ${JSON.stringify(armed)}`);

  // Nothing has been written yet: the game does not save on boot.
  const before = await page.evaluate(() => window.__dbgSaves.list());
  check(before.length === 0, `${before.length} characters existed before anything saved`);

  // Name the character first, so the record the timer writes is a real one.
  await page.evaluate(() => window.__dbgSaves.newCharacter('Tick'));
  await page.evaluate(() => window.__dbgAdvance(3));
  const afterTimer = await page.evaluate(async () => ({
    list: await window.__dbgSaves.list(),
    state: window.__dbgSaves.autosave(),
  }));
  out.autosave.afterTimer = {
    names: afterTimer.list.map((r) => r.name), since: afterTimer.state.sinceSec,
  };
  check(afterTimer.list.length === 1 && afterTimer.list[0].name === 'Tick',
    `the timer wrote ${JSON.stringify(out.autosave.afterTimer.names)}`);
  // And the clock went back, or it would write every frame from here on.
  check(afterTimer.state.sinceSec < 2,
    `the clock was not reset by the write: ${afterTimer.state.sinceSec}`);

  // THE QUEST TRIGGER. A status change arms a short debounce rather than
  // writing per notification — one action list is several changes.
  //
  // ASSERTED ON THE CONTENT OF THE RECORD, not on its timestamp. `updatedAt` is
  // wall-clock and every advance here is SIMULATED — three simulated seconds
  // pass in under a millisecond of real time — so two consecutive writes
  // legitimately share a timestamp and "did it change?" is unanswerable from
  // it. What the trigger is for is getting the new fact onto disk, so that is
  // what this reads back.
  const id = afterTimer.list[0].id;
  const quest = await page.evaluate(async (n) => {
    const before = Object.keys((await window.__dbgSaves.read(n))?.content?.quests ?? {}).length;
    // The same driver the journal probe uses: it loads the example-quest
    // package and sets every quest in it active, which is a real status change
    // through the store the content actions write through.
    await window.__dbgQuestStage();
    const armedAt = window.__dbgSaves.autosave().questIn;
    window.__dbgAdvance(3);
    // SETTLE ON THE RECORD, not on a guess about when the write lands. The
    // autosave is fire-and-forget by design — nothing in the game waits on it —
    // so the transaction is still in flight when the advance returns.
    let after = 0;
    for (let i = 0; i < 40 && after === 0; i++) {
      after = Object.keys((await window.__dbgSaves.read(n))?.content?.quests ?? {}).length;
      if (after === 0) await new Promise((r) => setTimeout(r, 50));
    }
    return {
      armedAt,
      before,
      after,
      rows: (await window.__dbgSaves.list()).length,
    };
  }, id);
  out.autosave.afterQuest = quest;
  check(quest.armedAt > 0, 'a quest changing state armed no save');
  check(quest.before === 0, `the record already held ${quest.before} quests before staging any`);
  check(quest.after > 0, 'the quest-triggered save never wrote the new quest state');
  check(quest.rows === 1, `the quest trigger made ${quest.rows} records instead of updating one`);

  await ctx.close();
}

// ---------------------------------------------------------------------------
// 8. THE WHOLE THING THROUGH THE TITLE SCREEN, which is the only case here that
//    proves the UI is wired to any of the above. Name a character, play, come
//    back to the poster, and load them from the list.
//
//    `fs=0` because New Game is clicked (AGENTS.md), and no `menu=0` because the
//    menu is the subject.
// ---------------------------------------------------------------------------
{
  const { ctx, page } = await newContextPage(browser, { width: 1000, height: 700 });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(`${HOST}/?fs=0&vol=0&${NO_WARMUP}`, { waitUntil: 'load' });
  await page.waitForSelector('.bs-menu');
  await leaveSplash(page);

  // Load is down before there is anything to load, and the note says why.
  out.menu = await page.evaluate(() => ({
    loadDisabled: document.querySelector('.bs-menu [data-act="load"]')?.disabled ?? null,
    note: document.querySelector('.bs-menu .note')?.textContent ?? null,
  }));
  check(out.menu.loadDisabled === true, 'Load is live on a machine with no characters');

  await page.click('.bs-menu [data-act="new"]');
  await page.waitForSelector('.bs-name-input');
  // Typed, not set: this goes through the capture-phase key handler, and 's' is
  // the key that walks the cursor down everywhere else on this screen.
  await page.keyboard.type('Wisp');
  const typed = await page.evaluate(() => document.querySelector('.bs-name-input').value);
  check(typed === 'Wisp', `the name field holds "${typed}" after typing Wisp`);

  await page.click('.bs-menu [data-act="begin"]');
  await whenPlaying(page);
  const named = await page.evaluate(() => window.__dbgSaves.doc().name);
  check(named === 'Wisp', `the session is playing as "${named}", not Wisp`);

  // Something to tell this character apart by, then save and go back.
  await page.evaluate(async () => {
    window.__dbgGive('sunberry', 9);
    await window.__dbgSaves.save();
  });
  const savedBag = await page.evaluate(() => window.__dbgSaves.doc().bag.length);

  // Exit to title through the pause menu's own button, which is the route a
  // player has — and the one that clears the active character.
  await page.evaluate(() => window.__dbgBoot && null);
  await page.keyboard.press('F10');
  await page.waitForSelector('.bs-pause [data-act="exit"]');
  await page.click('.bs-pause [data-act="exit"]');
  await page.waitForSelector('.bs-menu [data-act="load"]:not([disabled])', { timeout: 10000 });

  const listed = await page.evaluate(() => ({
    rows: document.querySelectorAll('.bs-menu [data-act="load"]').length,
    disabled: document.querySelector('.bs-menu [data-act="load"]')?.disabled ?? null,
  }));
  out.menu.afterOneCharacter = listed;
  check(listed.disabled === false, 'Load is still down after a character was saved');

  await page.click('.bs-menu [data-act="load"]');
  await page.waitForSelector('.bs-save-row');
  const row = await page.evaluate(() => {
    const el = document.querySelector('.bs-save-row .save');
    return { name: el?.querySelector('.nm')?.textContent ?? null,
      meta: el?.querySelector('.meta')?.textContent ?? null };
  });
  out.menu.row = row;
  check(row.name === 'Wisp', `the list row is named "${row.name}"`);
  check(/\d/.test(row.meta ?? ''), `the row's power/date line reads "${row.meta}"`);

  await page.click('.bs-save-row .save');
  await whenPlaying(page);
  const back = await page.evaluate(() => {
    const doc = window.__dbgSaves.doc();
    return { name: doc.name, bag: doc.bag.length, active: window.__dbgSaves.active() };
  });
  out.menu.loaded = back;
  check(back.name === 'Wisp', `loading from the list gave "${back.name}"`);
  check(back.bag === savedBag, `the bag came back with ${back.bag} kinds, saved ${savedBag}`);
  check(typeof back.active === 'number', 'the loaded character is not the active save');

  await ctx.close();
}

console.log(JSON.stringify(out, null, 2));
if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n  ${fails.join('\n  ')}`);
  await browser.close();
  process.exit(1);
}
console.log('\nOK');
await browser.close();
