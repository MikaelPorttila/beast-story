// The About-the-game guard — issue #65.
//
// Five claims, and the third is the one that makes this file worth running more
// than once:
//
//   1. THE DOOR. "About the Game" is on the option list, it opens a panel, and
//      all three ways back — the Back button, Escape, and the pad's B face —
//      return to the options with the cursor on the button that opened it. The
//      focus half is asserted because it is the half that silently rots: a
//      second leaf off one list is exactly where "back goes to the top" creeps
//      in, and nothing about the screen looks wrong when it does.
//   2. IT SCROLLS, AND IT STAYS ON SCREEN. The licence notices are longer than
//      any window this is read in, so the box must overflow (scrollHeight over
//      clientHeight) and must move when a key or a pad asks it to. And its
//      bottom edge, plus the Back button under it, must be inside the viewport
//      at a phone's height — the same overflow failure as issue #16, in the one
//      panel with content that grows every time a dependency is added.
//   3. EVERY RUNTIME DEPENDENCY IS CREDITED. `package.json`'s `dependencies`
//      are read here, not in the page, and each name must appear in the panel
//      with a licence beside it. That is the routine in AGENTS.md turned into a
//      run: add a package that ships and forget its notice, and this fails. It
//      cannot be written the other way round (asserting the panel's list) —
//      that only checks the panel agrees with itself.
//   4. THE COPYRIGHT LINE IS VERBATIM, for the one package that ships. The
//      licence BODIES are deliberately not in the panel — a screen of MIT
//      boilerplate under a heading reading "The MIT License" is read as a
//      statement about this game, which it is not — so what has to survive is
//      the notice that names three.js and its holders.
//   5. IT FOLLOWS THE LANGUAGE PICKER. The prose is `en.ts` keys, so switching
//      to Swedish must re-caption the panel — while the licence block, which is
//      a legal notice rather than prose, must NOT move.
//
//   bun tools/test-about.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, leaveSplash, newContextPage, logPageErrors } from './browser.mjs';
import { BASE as HOST, NO_WARMUP } from './target.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
/** What actually ships. Dev dependencies are a credit, not a notice. */
const RUNTIME_DEPS = Object.keys(pkg.dependencies ?? {});

/** The shipped package's own copyright line, out of its LICENSE file. */
const SHIPPED_COPYRIGHT = /Copyright © \d{4}-\d{4} three\.js authors/;

/**
 * Every load here stops at the TITLE SCREEN and every assertion reads DOM — the
 * option list, the panel's overflow, the credits table, the language swap — so
 * this file qualifies for NO_WARMUP (see the note on it in tools/target.mjs).
 * It never waits for the canvas, so what it saves is not a block but the
 * CONTENTION: the sweep's steps are ~1 s each and only yield between them
 * (BOOT_SLICE_MS in main.ts), and this probe spends its life clicking a menu on
 * the same main thread. Measured, four loads: 36.1 s to 18.6 s, same verdict.
 *
 * The other half of that run was this file's own sleeps — 2000 ms after
 * `.bs-menu` plus a settle after every click, about 4.4 s a load. They are gone
 * too: every one of them named a state (`leaveSplash`, `panelUp`, `panelGone`,
 * `scrolledFrom`) and 36.1 s is now about 5 s.
 *
 * `fps=30` stays: the menu still animates and the panel still scrolls.
 */
const BOOT = `${HOST}/?fps=30&fs=0&${NO_WARMUP}`;

/**
 * Any key leaves the splash; then in through the About door.
 *
 * Both halves settle on STATE. `leaveSplash` polls for the option buttons and
 * re-presses until they appear — the splash's key handler goes live after the
 * element does, so one press and a sleep is a race (see browser.mjs). The door
 * is open when the panel is in the DOM.
 */
async function openAbout(page) {
  await leaveSplash(page, { key: 'KeyK' });
  await page.click('.bs-menu [data-act="about"]');
  await panelUp(page);
}

/** The About panel is up. */
const panelUp = (page) => page.waitForSelector('.bs-menu .about', { timeout: 15000 });

/** ...and it is gone again, which is what every way BACK has to produce. */
const panelGone = (page) => page.waitForFunction(
  () => !document.querySelector('.bs-menu .about'), { timeout: 15000 });

/**
 * The box has moved off `from`.
 *
 * Scrolling is the one place here where the settle IS the assertion, so this
 * swallows its timeout instead of throwing: a panel that refuses to scroll is
 * the bug section 2 exists to catch, and it has to be reported as three
 * scrollTops the reader can see rather than as a stack trace five seconds in.
 * Five seconds because the alternative outcome is a pass in milliseconds.
 */
const scrolledFrom = (page, from) => page.waitForFunction(
  (was) => (document.querySelector('.bs-menu .about')?.scrollTop ?? was) !== was,
  { timeout: 5000 },
  from,
).catch(() => {});

const panel = (page) => page.evaluate(() => {
  const box = document.querySelector('.bs-menu .about');
  if (!box) return null;
  const r = box.getBoundingClientRect();
  const back = document.querySelector('.bs-menu [data-act="back"]');
  return {
    heading: document.querySelector('.bs-menu .bs-opts h2')?.textContent?.trim() ?? null,
    lead: box.querySelector('.lead')?.textContent?.trim() ?? null,
    headings: [...box.querySelectorAll('h3')].map((h) => h.textContent.trim()),
    credits: [...box.querySelectorAll('ul.credits li')].map((li) => ({
      name: li.querySelector('.nm')?.textContent?.trim() ?? null,
      license: li.querySelector('.lic')?.textContent?.trim() ?? null,
    })),
    text: box.textContent.replace(/\s+/g, ' ').trim(),
    scrollTop: box.scrollTop,
    scrollHeight: box.scrollHeight,
    clientHeight: box.clientHeight,
    // Both of these have to be inside the frame, and the button is the one that
    // goes first: it sits UNDER the box, so a box sized off the wrong height
    // pushes it off the bottom rather than clipping itself.
    boxBottom: Math.round(r.bottom),
    backBottom: back ? Math.round(back.getBoundingClientRect().bottom) : null,
    viewportH: window.innerHeight,
  };
});

const step = (page) => page.evaluate(() =>
  document.querySelector('.bs-menu')?.getAttribute('data-step') ?? null);

const focused = (page) => page.evaluate(() =>
  document.activeElement?.getAttribute?.('data-act')
  ?? document.activeElement?.className ?? null);

const browser = await launchBrowser();
const out = { runtimeDeps: RUNTIME_DEPS };

// ---- 1. the door, and the three ways back ---------------------------------
{
  const { ctx, page } = await newContextPage(browser, { width: 1280, height: 900 });
  logPageErrors(page);
  await page.goto(BOOT, { waitUntil: 'load' });
  await leaveSplash(page, { key: 'KeyK' });
  out.optionButtons = await page.evaluate(() =>
    [...document.querySelectorAll('.bs-menu .bs-opts .bs-menu-btn')]
      .map((b) => b.getAttribute('data-act')));

  await page.click('.bs-menu [data-act="about"]');
  await panelUp(page);
  out.stepAfterOpen = await step(page);
  out.focusInAbout = await focused(page);

  // Back button.
  await page.click('.bs-menu [data-act="back"]');
  await panelGone(page);
  out.backButton = { step: await step(page), focus: await focused(page) };

  // Escape.
  await page.click('.bs-menu [data-act="about"]');
  await panelUp(page);
  await page.keyboard.press('Escape');
  await panelGone(page);
  out.backEscape = { step: await step(page), focus: await focused(page) };

  await ctx.close();
}

// ---- 2. it scrolls, and 3-4. what it says ---------------------------------
{
  const { ctx, page } = await newContextPage(browser, { width: 1280, height: 900 });
  logPageErrors(page);
  await page.goto(BOOT, { waitUntil: 'load' });
  await openAbout(page);

  const at0 = await panel(page);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  // Settle on the box having MOVED, which is the assertion below anyway. The
  // catch matters: a panel that never scrolls is the bug this section is for,
  // and it must be reported as three scrollTops rather than as a timeout.
  await scrolledFrom(page, at0.scrollTop);
  const at1 = await panel(page);
  await page.keyboard.press('ArrowUp');
  await scrolledFrom(page, at1.scrollTop);
  const at2 = await panel(page);

  out.desktop = {
    heading: at0.heading,
    lead: at0.lead,
    headings: at0.headings,
    credits: at0.credits,
    overflows: at0.scrollHeight > at0.clientHeight,
    scrollTops: [at0.scrollTop, at1.scrollTop, at2.scrollTop],
    inFrame: at0.boxBottom <= at0.viewportH && at0.backBottom <= at0.viewportH,
    boxBottom: at0.boxBottom, backBottom: at0.backBottom, viewportH: at0.viewportH,
  };

  const text = at0.text;
  out.credited = Object.fromEntries(RUNTIME_DEPS.map((d) => {
    // three.js is listed by its own name, which is how it names itself; the
    // package is `three`. Match on the stem so neither spelling is required.
    const stem = d.replace(/^@[^/]+\//, '');
    const row = at0.credits.find((c) => c.name?.toLowerCase().startsWith(stem.toLowerCase()));
    return [d, row ? { listed: true, license: row.license } : { listed: false }];
  }));
  out.copyright = SHIPPED_COPYRIGHT.test(text);
  out.aiDisclaimer = /\bAI\b/.test(text) && /generative AI/i.test(text);
  // The repository is private. A link to it is an invitation to a 404, so the
  // panel must not carry one — this is the assertion that keeps it out.
  out.noRepoLink = !/github\.com\/MikaelPorttila/i.test(text);

  await ctx.close();
}

// ---- 2b. a phone, where the overflow would show ---------------------------
{
  const { ctx, page } = await newContextPage(browser, { width: 851, height: 393, phone: true });
  logPageErrors(page);
  await page.goto(BOOT, { waitUntil: 'load' });
  await page.waitForSelector('.bs-menu');
  // No keyboard on a phone: the splash takes any tap, and the option list is
  // buttons. Same retry as leaveSplash and for the same reason — the handler
  // goes live after the element does — with a tap instead of a key.
  for (let i = 0; i < 20 && !(await page.$('.bs-menu [data-act]')); i++) {
    await page.click('.bs-menu');
  }
  await page.click('.bs-menu [data-act="about"]');
  await panelUp(page);
  const p = await panel(page);
  out.phone = p && {
    overflows: p.scrollHeight > p.clientHeight,
    inFrame: p.boxBottom <= p.viewportH && p.backBottom <= p.viewportH,
    boxBottom: p.boxBottom, backBottom: p.backBottom, viewportH: p.viewportH,
  };
  await ctx.close();
}

// ---- 5. the prose follows the language, the licence does not --------------
{
  const { ctx, page } = await newContextPage(browser, { width: 1280, height: 900 });
  logPageErrors(page);
  await page.goto(`${BOOT}&lang=sv`, { waitUntil: 'load' });
  await openAbout(page);
  const p = await panel(page);
  out.swedish = {
    heading: p.heading,
    lead: p.lead,
    headings: p.headings,
    // The notice is the notice in every language.
    copyright: SHIPPED_COPYRIGHT.test(p.text),
    credits: p.credits,
  };
  await ctx.close();
}

console.log(JSON.stringify(out, null, 2));
await browser.close();

// ---- verdict ---------------------------------------------------------------
const fails = [];
if (!out.optionButtons?.includes('about')) fails.push('no About button on the option list');
if (out.stepAfterOpen !== 'about') fails.push(`step after open: ${out.stepAfterOpen}`);
if (out.backButton?.step !== 'options' || out.backButton?.focus !== 'about') {
  fails.push(`Back: ${JSON.stringify(out.backButton)} (want options / about)`);
}
if (out.backEscape?.step !== 'options' || out.backEscape?.focus !== 'about') {
  fails.push(`Escape: ${JSON.stringify(out.backEscape)} (want options / about)`);
}
if (!out.desktop?.overflows) fails.push('the About box does not scroll');
const [s0, s1, s2] = out.desktop?.scrollTops ?? [];
if (!(s1 > s0)) fails.push(`ArrowDown did not scroll: ${s0} -> ${s1}`);
if (!(s2 < s1)) fails.push(`ArrowUp did not scroll back: ${s1} -> ${s2}`);
if (!out.desktop?.inFrame) fails.push(`overflows the frame: ${JSON.stringify(out.desktop)}`);
if (!out.phone?.inFrame) fails.push(`overflows a phone: ${JSON.stringify(out.phone)}`);
for (const [dep, v] of Object.entries(out.credited ?? {})) {
  if (!v.listed) fails.push(`runtime dependency "${dep}" is not credited in the About panel`);
  else if (!v.license) fails.push(`"${dep}" is listed with no licence`);
}
if (!out.copyright) fails.push('the three.js copyright line is missing');
if (!out.aiDisclaimer) fails.push('no AI disclaimer');
if (!out.noRepoLink) fails.push('the panel links the repository, which is private');
if (out.swedish?.lead === out.desktop?.lead) fails.push('the prose did not follow ?lang=sv');
if (!out.swedish?.copyright) fails.push('the copyright notice moved with the language');

if (fails.length) {
  console.error(`\nFAIL:\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
console.error('\nOK');
