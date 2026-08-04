import { t } from '../i18n';

/**
 * ABOUT THE GAME — what this is, who made it, and what it is standing on.
 *
 * Issue #65. One view, built the same way ui/settings.ts is: this owns the
 * CONTENT and a host owns the SCREEN around it. `markup()` returns the rows and
 * not a wrapper, so the title screen puts them in the same `.bs-opts` column its
 * New Game button lives in and gets the wood-and-gold look for free. There is
 * one host today (ui/menu.ts); making it a module rather than a branch inside
 * that file is what stops the second one from being a copy.
 *
 * WHY IT READS THE WAY IT DOES
 *
 * The issue asks for terms someone with ADHD can act on, and that is a shape
 * rather than a vocabulary: the lead sentence says what the game IS, the bullets
 * are one fact each, and nothing needs a paragraph above it to make sense. A
 * player who reads only the first line has still been told what they are looking
 * at. Every heading below it is a question somebody actually arrives with —
 * what do I do, how is it made, was AI involved, who made it, what is it built
 * from — so the box can be skimmed rather than read.
 *
 * WHAT IS TRANSLATED AND WHAT IS NOT
 *
 * Prose and headings are `en.ts` keys, so the panel follows the language picker
 * three steps away on the same screen. THE LICENCE BLOCK IS NOT: a package's
 * name, its SPDX identifier and the MIT text itself are the legal notice we are
 * obliged to reproduce, and a translated licence is not the licence. They are
 * the constants below and they are English wherever the rest of the panel is.
 *
 * WHAT HAS TO BE LISTED, AND WHAT MERELY OUGHT TO BE
 *
 * Only what SHIPS carries an obligation. `three` is the whole of the runtime
 * dependency list, it is MIT, and MIT says the copyright notice and the
 * permission notice travel with every copy — so its full text is in `MIT_TEXT`
 * below and is rendered verbatim. Everything under `TOOLS` builds or tests the
 * game and is in nobody's browser, so those are a CREDIT rather than a notice:
 * name, version-independent, and the SPDX id. Adding a dependency means adding
 * it to one of these two lists in the same commit — the routine is written down
 * in AGENTS.md, because a licence list nobody updates is worse than none.
 */

/** A third-party package, as the panel lists one. */
interface Credit {
  name: string;
  /** SPDX identifier, exactly as the package's own `license` field spells it. */
  license: string;
  /** Whose copyright, as their own LICENSE file states it. Shipped code only. */
  copyright?: string;
  url: string;
}

/**
 * What is inside the build a player downloads.
 *
 * ONE ENTRY, and that is the point rather than an accident: everything the
 * renderer draws is generated in code (see AGENTS.md), so the only library that
 * reaches a browser is the one drawing it. If this list ever grows, the growth
 * is the thing to look at.
 */
const SHIPPED: ReadonlyArray<Credit> = [
  {
    name: 'three.js',
    license: 'MIT',
    copyright: 'Copyright © 2010-2026 three.js authors',
    url: 'https://threejs.org',
  },
];

/**
 * What builds and tests the game. Not shipped, so not a notice — a credit.
 *
 * Apache-2.0 asks that a copy of the licence travel with a DISTRIBUTION of the
 * work, and none of these is distributed: TypeScript and Vite run before the
 * build exists, Bun runs the tools, and puppeteer-core and pngjs only ever open
 * a headless browser on a developer's machine. Naming them and their licence is
 * what is owed and is also simply the decent thing.
 */
const TOOLS: ReadonlyArray<Credit> = [
  { name: 'TypeScript', license: 'Apache-2.0', url: 'https://www.typescriptlang.org' },
  { name: 'Vite', license: 'MIT', url: 'https://vite.dev' },
  { name: 'Bun', license: 'MIT', url: 'https://bun.sh' },
  { name: 'puppeteer-core', license: 'Apache-2.0', url: 'https://pptr.dev' },
  { name: 'pngjs', license: 'MIT', url: 'https://github.com/pngjs/pngjs' },
];

/**
 * The MIT licence, verbatim, once.
 *
 * Once because it is the same text for every MIT package here and reproducing
 * it per entry would be five identical screens of type in a box a player is
 * scrolling. The copyright LINE differs per package and stays with the package,
 * above; this is the permission notice that has to travel with it.
 */
const MIT_TEXT =
  'Permission is hereby granted, free of charge, to any person obtaining a copy ' +
  'of this software and associated documentation files (the "Software"), to deal ' +
  'in the Software without restriction, including without limitation the rights ' +
  'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell ' +
  'copies of the Software, and to permit persons to whom the Software is ' +
  'furnished to do so, subject to the following conditions:\n\n' +
  'The above copyright notice and this permission notice shall be included in ' +
  'all copies or substantial portions of the Software.\n\n' +
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR ' +
  'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, ' +
  'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE ' +
  'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER ' +
  'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, ' +
  'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN ' +
  'THE SOFTWARE.';

/** Where the source lives. Shown as text — the poster has nothing to click to. */
const REPO = 'github.com/MikaelPorttila/beast-story';

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

const p = (s: string): string => `<p>${escapeHtml(s)}</p>`;
const h = (s: string): string => `<h3>${escapeHtml(s)}</h3>`;

function creditRow(c: Credit): string {
  return '<li>' +
    `<span class="nm">${escapeHtml(c.name)}</span>` +
    `<span class="lic">${escapeHtml(c.license)}</span>` +
    (c.copyright ? `<span class="cr">${escapeHtml(c.copyright)}</span>` : '') +
    `<span class="url">${escapeHtml(c.url)}</span>` +
  '</li>';
}

/**
 * The whole panel, for a host to put inside its own `.bs-opts` column.
 *
 * The scroll box is a real focus stop (`tabindex="0"`) so a keyboard can page
 * through it, and the host scrolls it from the arrow keys and the pad — see the
 * `about` branch in ui/menu.ts. It has to scroll: this is the one screen in the
 * game whose content is longer than any window it will be read in, and the
 * alternative to a scrollbar is type below the 16px floor (issue #17).
 */
export function aboutMarkup(): string {
  return (
    `<h2>${escapeHtml(t('menu.about'))}</h2>` +
    '<div class="about" tabindex="0" role="region" ' +
    `aria-label="${escapeHtml(t('menu.about'))}">` +
      `<p class="lead">${escapeHtml(t('about.lead'))}</p>` +

      h(t('about.what')) +
      '<ul>' +
        `<li>${escapeHtml(t('about.what.1'))}</li>` +
        `<li>${escapeHtml(t('about.what.2'))}</li>` +
        `<li>${escapeHtml(t('about.what.3'))}</li>` +
        `<li>${escapeHtml(t('about.what.4'))}</li>` +
      '</ul>' +

      h(t('about.made')) +
      p(t('about.made.body')) +

      h(t('about.ai')) +
      p(t('about.ai.body')) +

      h(t('about.credits')) +
      p(t('about.credits.body')) +
      `<p class="repo">${escapeHtml(REPO)}</p>` +

      h(t('about.licenses')) +
      p(t('about.licenses.shipped')) +
      `<ul class="credits">${SHIPPED.map(creditRow).join('')}</ul>` +
      p(t('about.licenses.tools')) +
      `<ul class="credits">${TOOLS.map(creditRow).join('')}</ul>` +
      `<h4>${escapeHtml(t('about.licenses.mit'))}</h4>` +
      `<pre class="mit">${escapeHtml(MIT_TEXT)}</pre>` +
    '</div>'
  );
}
