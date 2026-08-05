// The music guard: what is loaded, what is NOT, and what a fade actually does.
//
// Seven claims, and the first is the one that keeps every other probe in this
// directory quiet:
//
//   1. A DEBUG BOOT IS SILENT. `menu=0`, `photo=1`, `fs=0` and `fps=` are the
//      four markers no player's URL carries, so a run under any of them starts
//      at volume 0 — no element, no request, nothing to unload. That is the
//      rule AGENTS.md states, and it is a property of core/flags.ts rather than
//      of twenty tools remembering a parameter.
//   2. `vol=` BEATS IT. An explicit volume is how a change that needs audio
//      turns the sound back on for one load, and it must win over the
//      inference above or the escape hatch is not one.
//   3. THE FADE IS REAL. `output` (master x envelope x swap) is near zero at
//      the head of a track and up at the master a couple of seconds later. This
//      is the assertion the whole feature exists for: both tracks are cut rough
//      and a raw loop clicks.
//   4. NEW GAME IS A SCENE CHANGE. The title track goes and the overworld's
//      arrives — a second `starts`, a different file, and only ever one element.
//   5. SO IS EXIT TO TITLE, in the other direction.
//   6. THE VOLUME ROW UNLOADS AT ZERO and reloads above it, writing one key.
//   7. AN AREA'S PLAYLIST IS CONTENT, and an area nobody scored gets the
//      fallback one rather than silence. The second half is the only claim in
//      this file that the arrangement it replaced could not have satisfied.
//
// It cannot assert on SOUND — headless has no speakers, and reading the
// element's own `volume` back is the only honest signal there is. What that
// number cannot see is whether the file decodes, so `playing` is read too: a
// browser that could not play the codec would leave it false with `output`
// climbing regardless.
//
//   bun tools/test-music.mjs
import { launchBrowser, newContextPage, wait, logPageErrors } from './browser.mjs';
import { BASE as HOST } from './target.mjs';

const music = (page) => page.evaluate(() => window.__dbgMusic?.() ?? null);

const volKey = (page) => page.evaluate(
  () => localStorage.getItem('game.settings.gameplay.volume'),
);

const fails = [];
const check = (ok, what) => { if (!ok) fails.push(what); return ok; };

/** Wait for the boot to finish, whether it is staged or not. */
const booted = (page) => page.waitForFunction(
  () => typeof window.__dbgMusic === 'function', { timeout: 60000 },
);

const browser = await launchBrowser();
const out = {};

// ---- 1. a probe boot makes no sound and loads nothing ----------------------
{
  const { ctx, page } = await newContextPage(browser, { width: 1000, height: 700 });
  logPageErrors(page);
  await page.goto(`${HOST}/?fps=30&menu=0`, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await booted(page);
  // A click, so this is not passing merely because nothing has been touched:
  // the gesture that would unblock a refused play happens and there is still
  // nothing to unblock.
  await page.mouse.click(500, 350);
  await wait(1200);
  out.probeBoot = await music(page);
  check(out.probeBoot?.volume === 0, 'probe boot: volume should be 0');
  check(out.probeBoot?.loaded === false, 'probe boot: nothing should be loaded');
  check(out.probeBoot?.starts === 0, 'probe boot: nothing should have started');
  await ctx.close();
}

// ---- 2/3. vol= wins, the track plays, and the head fades in ----------------
{
  const { ctx, page } = await newContextPage(browser, { width: 1000, height: 700 });
  logPageErrors(page);
  // Every silent-boot marker there is, plus an explicit volume. The override has
  // to beat all four at once.
  await page.goto(`${HOST}/?fps=30&menu=0&fs=0&vol=0.5`, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await booted(page);
  // The gesture. Nothing here calls `unlock()` — this goes through the capture
  // listener the director arms for itself when a play is refused, which is the
  // path a player takes when they click the poster.
  await page.mouse.click(500, 350);
  await wait(250);
  out.head = await music(page);
  await wait(2200);
  out.settled = await music(page);

  check(out.head?.volume === 0.5, 'vol=: the URL must beat silentBoot');
  check(/overworld/.test(out.head?.track ?? ''), 'menu=0 boots straight into the overworld track');
  check(out.settled?.playing === true, 'the element should be playing (codec decodes)');
  // The fade: quiet at the head, at the master two seconds later. The floor is
  // the assertion — a director that simply assigned the master would read 0.5
  // on the first sample.
  check(out.head?.output < 0.25, `head should be faded down, got ${out.head?.output}`);
  check(out.settled?.output > 0.45, `should reach the master, got ${out.settled?.output}`);
  check(out.settled?.at > 1, 'the playhead should have moved');

  // ---- the LOOP SEAM, which is the whole reason the fades exist ------------
  // The tail is 210 seconds away, so the playhead is moved to a second and a
  // half before the end (`__dbgMusicSeek`) and the wrap is watched happening.
  // What is being asserted is that the two ends MEET: down to near silence
  // before the wrap, back up after it, and never a jump straight from the
  // master to the master across the join — which is the click the tracks have
  // in them and the whole of what was asked for.
  await page.evaluate(() => window.__dbgMusicSeek(window.__dbgMusic().duration - 1.4));
  await wait(500);
  out.tail = await music(page);
  await wait(1600);
  out.wrapped = await music(page);
  check(out.tail?.output < 0.2, `tail should be faded down, got ${out.tail?.output}`);
  check(out.wrapped?.loops === 1, `should have looped once, got ${out.wrapped?.loops}`);
  check(out.wrapped?.at < 2, 'and be back at the head of the track');
  check(out.wrapped?.output < 0.45, `the head after a wrap fades in too, got ${out.wrapped?.output}`);
  await ctx.close();
}

// ---- 4/5/6. the scene changes, and the volume row --------------------------
{
  const { ctx, page } = await newContextPage(browser, { width: 1000, height: 700 });
  logPageErrors(page);
  // The staged boot, which is the only one with a title screen to play the
  // splash track under. `fs=0` keeps the viewport still; `vol=` overrides the
  // silence it would otherwise imply.
  await page.goto(`${HOST}/?fs=0&vol=0.6`, { waitUntil: 'load' });
  await page.waitForSelector('.bs-menu');
  await booted(page);
  await wait(600);
  out.atSplash = await music(page);
  check(/title/.test(out.atSplash?.track ?? ''), 'the title screen plays the title track');
  check(out.atSplash?.scene === 'title', 'scene should be title');

  // Any key leaves the splash — and is the gesture that makes noise legal.
  //
  // TWICE, POSSIBLY. A press during the three-beat entrance FINISHES it rather
  // than advancing past it (see `advanceFromPress` in ui/menu.ts), and how far
  // through that entrance the first press lands depends on how long the images
  // took to decode — which is the difference between a cold and a warm dev
  // server. So this presses until the options are on screen instead of assuming
  // one press did it, which is a race a fixed wait loses about half the time.
  for (let i = 0; i < 5 && !(await page.$('.bs-menu [data-act="new"]')); i++) {
    await page.keyboard.press('KeyK');
    await wait(700);
  }
  await page.waitForSelector('.bs-menu [data-act="new"]', { timeout: 10000 });
  await wait(900);
  out.atOptions = await music(page);
  check(out.atOptions?.playing === true, 'the title track should play after a gesture');

  // New Game. The boot may still be in its shader phase, so wait for the
  // handover rather than for a fixed time.
  await page.click('.bs-menu [data-act="new"]');
  await page.waitForFunction(
    () => /overworld/.test(window.__dbgMusic()?.track ?? ''), { timeout: 60000 },
  );
  await wait(1500);
  out.inGame = await music(page);
  check(out.inGame?.scene === 'overworld', 'New Game switches the scene');
  check(out.inGame?.starts === 2, `exactly two tracks started, got ${out.inGame?.starts}`);
  check(out.inGame?.playing === true, 'the overworld track should be playing');

  // The volume row, from the in-game menu — the same panel the title screen
  // shows (ui/settings.ts), which is why it is only driven once. F10 is the
  // menu key; Escape belongs to the browser.
  await page.keyboard.press('F10');
  await wait(400);
  await page.click('.bs-pause [data-act="settings"]');
  await wait(300);
  // The list is four sections and only the one showing is in the DOM, so the
  // volume strip has to be asked for by name (ui/settings.ts). Its tab is Sound
  // even though the key it writes is still `game.settings.gameplay.volume` — a
  // storage group is fixed on the day a setting ships, and renaming that key
  // would silently reset the level of everyone who had already chosen one.
  await page.click('.bs-pause [data-tab="sound"]');
  await wait(300);
  out.chips = await page.evaluate(() => [...document.querySelectorAll('.bs-pause [data-vol]')]
    .map((b) => ({ v: b.getAttribute('data-vol'), on: b.classList.contains('on') })));
  check(out.chips.length === 6, `six volume steps, got ${out.chips.length}`);
  check(out.chips.filter((c) => c.on).length === 1, 'exactly one chip lit');
  // 80, NOT the 60 this load is running at, and that is the URL override
  // behaving: `vol=` pins a value for one load and never writes the preference,
  // exactly as `haptics=` and `shake=` do. The panel shows what is STORED,
  // which is still the shipped default. `/volume` says so out loud.
  check(out.chips.find((c) => c.on)?.v === '80', 'the lit chip is the STORED level, not the pin');

  await page.click('.bs-pause [data-vol="0"]');
  await wait(400);
  out.muted = await music(page);
  out.mutedKey = await volKey(page);
  check(out.muted?.loaded === false, 'OFF unloads the track');
  check(out.muted?.volume === 0, 'OFF is volume 0');
  check(out.mutedKey === '0', `one key, written as 0, got ${out.mutedKey}`);

  await page.click('.bs-pause [data-vol="80"]');
  await wait(600);
  out.unmuted = await music(page);
  out.unmutedKey = await volKey(page);
  check(out.unmuted?.loaded === true, 'coming back up reloads the track');
  check(/overworld/.test(out.unmuted?.track ?? ''), 'and it is the scene we are in');
  check(out.unmutedKey === '0.8', `stored as a decimal, got ${out.unmutedKey}`);

  // Exit to title: the other scene change.
  await page.keyboard.press('F10');
  await wait(300);
  await page.click('.bs-pause [data-act="exit"]');
  await page.waitForFunction(
    () => /title/.test(window.__dbgMusic()?.track ?? ''), { timeout: 20000 },
  );
  out.backAtTitle = await music(page);
  check(out.backAtTitle?.scene === 'title', 'Exit goes back to the title track');
  check(out.backAtTitle?.starts === 4, `four tracks over the session, got ${out.backAtTitle?.starts}`);
  await ctx.close();
}

// ---- 7. the playlist is content, and an unscored area falls back -----------
//
// Claim seven, and it is a PAIR at one column in the sense the rest of this
// directory means it. "The overworld plays the overworld track" is equally true
// of a content-driven playlist and of the hard-coded TRACKS map this replaced,
// so on its own it asserts nothing about the migration. What only the new
// arrangement can do is answer for an area that does not exist — there is no
// `music:nowhere` asset and there never will be — and still name a song. That
// is the fallback, and it is the half of the request that has no other witness.
//
// `__dbgMusicScene` rather than a walk to the gateway: see the hook in main.ts.
{
  const { ctx, page } = await newContextPage(browser, { width: 1000, height: 700 });
  logPageErrors(page);
  await page.goto(`${HOST}/?fps=30&menu=0&fs=0&vol=0.5`, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await booted(page);
  await page.mouse.click(500, 350);
  await wait(1200);

  out.scored = await music(page);
  check(out.scored?.scene === 'overworld', 'the area is the overworld');
  check(out.scored?.playlist?.length === 1, `one track in it, got ${out.scored?.playlist?.length}`);
  check(/overworld/.test(out.scored?.playlist?.[0] ?? ''), 'and it is the overworld song');
  check(out.scored?.index === 0, `playing the first entry, got ${out.scored?.index}`);

  // An area with no asset. Two things must be true at once and only the second
  // is about the fallback: it resolves to a real playlist, AND it does not
  // restart the song, because a playlist equal to the one already playing is
  // the case `setScene` keeps rather than swaps. A director that reloaded here
  // would tick `starts` and the player would hear the music jump back to its
  // head every time they walked through a gateway between two areas scored the
  // same way.
  const startsBefore = out.scored?.starts;
  await page.evaluate(() => window.__dbgMusicScene('nowhere-at-all'));
  await wait(700);
  out.unscored = await music(page);
  check(out.unscored?.scene === 'nowhere-at-all', 'the scene moved');
  check(
    (out.unscored?.playlist?.length ?? 0) > 0,
    'an area nobody scored still gets the fallback playlist',
  );
  check(out.unscored?.starts === startsBefore, 'and an identical playlist is not restarted');
  check(out.unscored?.playing === true, 'still playing across the change');

  // THE CONTROL. Everything above would read the same on a dead hook that moved
  // nothing at all, so the scene is driven somewhere that must audibly differ:
  // null is silence, and silence unloads.
  await page.evaluate(() => window.__dbgMusicScene(null));
  await page.waitForFunction(
    () => window.__dbgMusic()?.loaded === false, { timeout: 8000 },
  );
  out.silent = await music(page);
  check(out.silent?.loaded === false, 'a null scene unloads — the hook really moves things');
  check(out.silent?.playlist?.length === 0, 'and reports an empty playlist');
  await ctx.close();
}

out.failures = fails;
console.log(JSON.stringify(out, null, 2));
await browser.close();
if (fails.length) process.exit(1);
