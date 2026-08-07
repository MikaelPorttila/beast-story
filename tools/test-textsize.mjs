// THE 16px FLOOR — issue #17. "No text should be below 16px."
//
// The report is about a TV: the HUD's smallest labels were 8.5px, and the three
// the reporter named — the mount prompt, the hotbar's key numbers and the NPC
// interact pill — were 10.5, 10 and 13.5. At a couch's distance, or with any
// degree of low vision, those are not small type, they are absent type.
//
// TWO PASSES, because neither one alone can see the whole surface.
//
//   1. A STATIC SCAN of the two stylesheets, which needs no browser and is the
//      pass that catches a rule nothing on screen happens to be matching right
//      now — an empty bag, a shop with no offers, a toast that is not up. It
//      reads a LOWER BOUND on what a declaration can resolve to, so
//      `clamp(9px,...,12px)` counts as 9 and `max(16px,.86em)` as 16.
//   2. A LIVE SWEEP of computed font sizes over what is actually rendered, at
//      desktop and at both phone orientations, which is the pass that catches
//      text carrying an INHERITED size no declaration names — the shop's chip
//      labels, a <b> inside a pill, anything added to the DOM without a rule of
//      its own. A media query that undoes the floor only shows up here.
//
// WHAT IS EXEMPT, and why it is a list rather than a rule. The developer
// instruments — the § console, the F2 overlay and the F3 Debug panel, spawner
// tree included (`.bs-spawn-*`, which only ever renders inside it) — are monospace
// readouts for whoever is building the game, not player-facing UI, and they are
// deliberately dense: F3 is meant to be read BESIDE F2 without either covering
// the world. A player never opens them. Everything else is in.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, newContextPage, wait } from './browser.mjs';
import { BASE as HOST, NO_WARMUP } from './target.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MIN_PX = 16;

/** Selector prefixes whose type is an instrument's, not the player's. */
const DEV_ONLY = ['.bs-console', '.bs-perf', '.bs-spawn'];

// ---- pass 1: the stylesheets -------------------------------------------------

/**
 * A LOWER BOUND on the px a font-size value can resolve to, or null when no
 * bound can be proven statically. A bound rather than the exact minimum, because
 * that is what the floor needs and it is decidable far more often:
 *
 *   clamp(a,b,c)  the bound IS a, whatever b and c are — which is the whole
 *                 reason a responsive size is written as a clamp with a px
 *                 lower arm rather than as a bare calc().
 *   min(...)      the smallest argument, so ONE unknown argument sinks it.
 *   max(...)      the largest KNOWN argument is already a bound — which is why
 *                 `max(16px,.86em)` is how a relative size keeps the floor no
 *                 matter what its parent turns out to be.
 *
 * Anything left over — a bare `calc()`, a lone `em`, a viewport unit — is
 * reported as undecidable rather than passed, and the live sweep is what has to
 * answer for it.
 */
function floorPx(value) {
  const v = value.trim();
  const inner = v.match(/^(clamp|min|max)\((.*)\)$/s);
  if (inner) {
    const args = splitArgs(inner[2]).map(floorPx);
    if (inner[1] === 'clamp') return args[0] ?? null;
    if (inner[1] === 'max') {
      const known = args.filter((a) => a !== null);
      return known.length ? Math.max(...known) : null;
    }
    return args.some((a) => a === null) ? null : Math.min(...args);
  }
  const px = v.match(/^(-?[\d.]+)px$/);
  if (px) return parseFloat(px[1]);
  return null;
}

/** Split a function's argument list on top-level commas. */
function splitArgs(s) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/**
 * Every `font-size` declaration in one stylesheet source, with the selector it
 * belongs to. The sheets are template literals inside .ts files, so this reads
 * the file whole rather than parsing TypeScript — a `font-size` in a comment
 * would be a false positive, and there are none.
 */
function scanSheet(file) {
  const src = readFileSync(join(ROOT, file), 'utf8');
  // Strip /* ... */ so prose about a size is not mistaken for a declaration.
  const css = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const hits = [];
  const blockRe = /([^{};]+)\{([^{}]*)\}/g;
  let m;
  while ((m = blockRe.exec(css))) {
    const selector = m[1].replace(/\s+/g, ' ').trim();
    if (!selector || selector.startsWith('@') || selector.startsWith('from')
      || selector.startsWith('to') || /^\d/.test(selector)) continue;
    const decls = m[2];
    const sizeRe = /(?:^|[;\s])font-size\s*:\s*([^;}]+)/g;
    let d;
    while ((d = sizeRe.exec(decls))) {
      const raw = d[1].trim().replace(/!important$/, '').trim();
      hits.push({ file, selector, value: raw, px: floorPx(raw) });
    }
    // `font:` shorthand — the console and the F3 panel use it.
    const shortRe = /(?:^|[;\s])font\s*:\s*([^;}]+)/g;
    while ((d = shortRe.exec(decls))) {
      const size = d[1].trim().match(/(^|\s)([\d.]+px)(?=[\s/])/);
      if (size) hits.push({ file, selector, value: size[2], px: floorPx(size[2]) });
    }
  }
  return hits;
}

const declarations = [
  ...scanSheet('src/ui/styles.ts'),
  ...scanSheet('src/core/touch.ts'),
];
const playerFacing = declarations.filter(
  (h) => !DEV_ONLY.some((p) => h.selector.includes(p)),
);
const staticTooSmall = playerFacing
  .filter((h) => h.px !== null && h.px < MIN_PX)
  .map((h) => ({ file: h.file, selector: h.selector, value: h.value, px: h.px }));
// A declaration whose floor cannot be read statically is not a pass, it is a
// question the live sweep has to answer — reported so it is never silent.
const undecidable = playerFacing
  .filter((h) => h.px === null)
  .map((h) => ({ file: h.file, selector: h.selector, value: h.value }));

// ---- pass 2: what is on screen ----------------------------------------------

/**
 * Walk every element holding its own text and report anything computing under
 * the floor. `display:none` subtrees are skipped: a rule that only ever applies
 * to hidden markup is pass 1's business, and including them here would report
 * the phone block on a desktop run.
 */
const SWEEP = (min) => {
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('.bs-console,.bs-perf,.bs-spawn')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    // Own text only — a wrapper's font-size is judged where the glyphs are.
    let text = '';
    for (const n of el.childNodes) if (n.nodeType === 3) text += n.nodeValue;
    if (!text.trim()) continue;
    const px = parseFloat(cs.fontSize);
    if (px < min - 0.01) {
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: typeof el.className === 'string' ? el.className : '',
        text: text.trim().slice(0, 28),
        px: +px.toFixed(2),
      });
    }
  }
  return out;
};

const browser = await launchBrowser();
const live = {};

/**
 * The transient HUD — the interact pill, the dialogue, the mount ring, the
 * riding badge, a toast, the level-up banner, the shop — is not on screen during
 * an ordinary boot, and three of those are what issue #17 named. `__dbgStageHud`
 * (main.ts) raises all of them with the same calls a player's game makes.
 */
const STAGE = () => !!(window.__dbgStageHud && window.__dbgStageHud());

for (const [name, viewport, query] of [
// NO_WARMUP on all seven pages: every reading is a computed font-size out of
// getComputedStyle — see the note in tools/target.mjs.
  ['desktop', { width: 1600, height: 900 }, `?fps=30&menu=0&${NO_WARMUP}`],
  ['desktop-narrow', { width: 1000, height: 700 }, `?fps=30&menu=0&${NO_WARMUP}`],
  ['phone-portrait', { width: 393, height: 851, phone: true }, `?fps=30&menu=0&${NO_WARMUP}`],
  ['phone-landscape', { width: 851, height: 393, phone: true }, `?fps=30&menu=0&${NO_WARMUP}`],
  ['title', { width: 1600, height: 900 }, `?photo=1&menu=1&fs=0&${NO_WARMUP}`],
  ['title-short', { width: 1000, height: 560 }, `?photo=1&menu=1&fs=0&${NO_WARMUP}`],
  ['title-phone', { width: 851, height: 393, phone: true }, `?photo=1&menu=1&fs=0&${NO_WARMUP}`],
]) {
  const { ctx, page } = await newContextPage(browser, viewport);
  await page.goto(`${HOST}/${query}`, { waitUntil: 'load' });
  await page.waitForSelector('canvas,.bs-menu');
  await wait(2500);
  let staged = 'n/a';
  if (query.includes('menu=0')) {
    staged = await page.evaluate(STAGE).catch(() => false);
    // The modal a player opens from the keyboard, over the shop the hook left up.
    await page.keyboard.press('F1');
    await wait(350);
  } else {
    // The title screen's own type only exists past the splash: step one is a
    // wordmark and four words, and every button, row, pill and language chip is
    // behind a keypress. Settings is the tallest step and the one whose height
    // media queries the floor moved, so the sweep ends there.
    await page.keyboard.press('Enter');
    await wait(500);
    const opened = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.bs-menu .bs-menu-btn')]
        .find((b) => /setting/i.test(b.textContent || ''));
      if (!btn) return false;
      btn.click();
      return true;
    });
    await wait(500);
    staged = opened ? 'settings' : 'options-only';
  }
  let tooSmall = await page.evaluate(SWEEP, MIN_PX);
  if (staged === 'settings') {
    // EVERY SECTION, not just the one the panel opens on. The settings list is
    // four tabs and only the visible one is in the DOM (ui/settings.ts), so a
    // sweep that stopped here would never look at the graphics rows or the
    // volume strip — which is precisely the half of the panel that is new, and
    // precisely how a floor stops covering the thing it was written for.
    for (const tab of ['controls', 'graphics', 'sound']) {
      const opened = await page.evaluate((t) => {
        const b = document.querySelector(`.bs-menu [data-tab="${t}"]`);
        if (!b) return false;
        b.click();
        return true;
      }, tab);
      if (!opened) continue;
      await wait(300);
      tooSmall = tooSmall.concat(await page.evaluate(SWEEP, MIN_PX));
    }
    // AND THE ABOUT STEP, which is the densest block of type in the game and so
    // the one most likely to be shrunk to fit (ui/about.ts, issue #65). It is a
    // sibling of Settings off the options list, so the sweep goes back one step
    // and in the other door rather than starting a second page.
    const inAbout = await page.evaluate(() => {
      document.querySelector('.bs-menu [data-act="back"]')?.click();
      return true;
    });
    if (inAbout) {
      await wait(350);
      const opened = await page.evaluate(() => {
        const b = document.querySelector('.bs-menu [data-act="about"]');
        if (!b) return false;
        b.click();
        return true;
      });
      if (opened) {
        await wait(400);
        staged = 'settings+about';
        tooSmall = tooSmall.concat(await page.evaluate(SWEEP, MIN_PX));
      }
    }
  }
  live[name] = { staged, tooSmall };
  await ctx.close();
}

await browser.close();

const liveFailures = Object.entries(live)
  .filter(([, v]) => v.tooSmall.length)
  .map(([k, v]) => `${k}: ${v.tooSmall.length}`);

const result = {
  minPx: MIN_PX,
  exempt: DEV_ONLY,
  stylesheets: {
    declarationsChecked: playerFacing.length,
    tooSmall: staticTooSmall,
    undecidableStatically: undecidable,
  },
  rendered: live,
  pass: staticTooSmall.length === 0 && liveFailures.length === 0,
};

console.log(JSON.stringify(result, null, 2));

if (!result.pass) {
  console.error(`\nFAIL: ${staticTooSmall.length} declaration(s) under ${MIN_PX}px`
    + `${liveFailures.length ? `, rendered text under the floor at ${liveFailures.join(', ')}` : ''}`);
  process.exit(1);
}
