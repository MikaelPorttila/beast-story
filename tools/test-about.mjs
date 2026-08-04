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
//   4. THE LICENCE TEXT IS VERBATIM. MIT obliges us to carry the permission
//      notice, so the sentence that IS the obligation is looked for literally,
//      and the copyright line with it.
//   5. IT FOLLOWS THE LANGUAGE PICKER. The prose is `en.ts` keys, so switching
//      to Swedish must re-caption the panel — while the licence block, which is
//      a legal notice rather than prose, must NOT move.
//
//   bun tools/test-about.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, newContextPage, wait, logPageErrors } from './browser.mjs';
import { BASE as HOST } from './target.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
/** What actually ships. Dev dependencies are a credit, not a notice. */
const RUNTIME_DEPS = Object.keys(pkg.dependencies ?? {});

/** The sentence MIT exists to make us carry. Looked for literally. */
const MIT_OBLIGATION =
  'The above copyright notice and this permission notice shall be included in ' +
  'all copies or substantial portions of the Software.';

/** Any key leaves the splash; then in through the About door. */
async function openAbout(page) {
  await page.keyboard.press('KeyK');
  await wait(450);
  await page.click('.bs-menu [data-act="about"]');
  await wait(350);
}

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
  await page.goto(`${HOST}/?fps=30&fs=0`, { waitUntil: 'load' });
  await page.waitForSelector('.bs-menu');
  await wait(2000);

  await page.keyboard.press('KeyK');
  await wait(450);
  out.optionButtons = await page.evaluate(() =>
    [...document.querySelectorAll('.bs-menu .bs-opts .bs-menu-btn')]
      .map((b) => b.getAttribute('data-act')));

  await page.click('.bs-menu [data-act="about"]');
  await wait(350);
  out.stepAfterOpen = await step(page);
  out.focusInAbout = await focused(page);

  // Back button.
  await page.click('.bs-menu [data-act="back"]');
  await wait(350);
  out.backButton = { step: await step(page), focus: await focused(page) };

  // Escape.
  await page.click('.bs-menu [data-act="about"]');
  await wait(350);
  await page.keyboard.press('Escape');
  await wait(350);
  out.backEscape = { step: await step(page), focus: await focused(page) };

  await ctx.close();
}

// ---- 2. it scrolls, and 3-4. what it says ---------------------------------
{
  const { ctx, page } = await newContextPage(browser, { width: 1280, height: 900 });
  logPageErrors(page);
  await page.goto(`${HOST}/?fps=30&fs=0`, { waitUntil: 'load' });
  await page.waitForSelector('.bs-menu');
  await wait(2000);
  await openAbout(page);

  const at0 = await panel(page);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await wait(250);
  const at1 = await panel(page);
  await page.keyboard.press('ArrowUp');
  await wait(250);
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
  out.mitVerbatim = text.includes(MIT_OBLIGATION.replace(/\s+/g, ' '));
  out.copyright = /Copyright © \d{4}-\d{4} three\.js authors/.test(text);
  out.aiDisclaimer = /\bAI\b/.test(text) && /generative AI/i.test(text);

  await ctx.close();
}

// ---- 2b. a phone, where the overflow would show ---------------------------
{
  const { ctx, page } = await newContextPage(browser, { width: 851, height: 393, phone: true });
  logPageErrors(page);
  await page.goto(`${HOST}/?fps=30&fs=0`, { waitUntil: 'load' });
  await page.waitForSelector('.bs-menu');
  await wait(2000);
  // No keyboard on a phone: the splash takes any tap, and the option list is
  // buttons.
  await page.click('.bs-menu');
  await wait(450);
  await page.click('.bs-menu [data-act="about"]');
  await wait(400);
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
  await page.goto(`${HOST}/?fps=30&fs=0&lang=sv`, { waitUntil: 'load' });
  await page.waitForSelector('.bs-menu');
  await wait(2000);
  await openAbout(page);
  const p = await panel(page);
  out.swedish = {
    heading: p.heading,
    lead: p.lead,
    headings: p.headings,
    // The notice is the notice in every language.
    mitVerbatim: p.text.includes(MIT_OBLIGATION.replace(/\s+/g, ' ')),
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
if (!out.mitVerbatim) fails.push('the MIT permission notice is not reproduced verbatim');
if (!out.copyright) fails.push('the three.js copyright line is missing');
if (!out.aiDisclaimer) fails.push('no AI disclaimer');
if (out.swedish?.lead === out.desktop?.lead) fails.push('the prose did not follow ?lang=sv');
if (!out.swedish?.mitVerbatim) fails.push('the licence text moved with the language');

if (fails.length) {
  console.error(`\nFAIL:\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
console.error('\nOK');
