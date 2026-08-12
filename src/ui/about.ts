import { t } from "../i18n";

/**
 * ABOUT THE GAME (issue #65). This owns the CONTENT; a host owns the screen, so
 * `aboutMarkup()` returns rows and no wrapper. Prose and headings are `en.ts`
 * keys; THE LICENCE BLOCK IS NOT — a translated legal notice is not the notice.
 * Full licence bodies are absent: MIT boilerplate under a heading reads as a
 * statement about THIS game.
 */

interface Credit {
  name: string;
  /** SPDX identifier, exactly as the package's own `license` field spells it. */
  license: string;
  /** Whose copyright, as their own LICENSE file states it. Shipped code only. */
  copyright?: string;
  url: string;
}

/**
 * What ships in the build. Dexie's own LICENSE leaves the Apache-2.0 copyright
 * placeholder unfilled, so its attribution comes from its bundle headers.
 */
const SHIPPED: ReadonlyArray<Credit> = [
  {
    name: "three.js",
    license: "MIT",
    copyright: "Copyright © 2010-2026 three.js authors",
    url: "https://threejs.org",
  },
  {
    name: "Dexie.js",
    license: "Apache-2.0",
    copyright: "By David Fahlander",
    url: "https://dexie.org",
  },
];

/** Build and test tooling. Not shipped, so a credit rather than a notice. */
const TOOLS: ReadonlyArray<Credit> = [
  { name: "TypeScript", license: "Apache-2.0", url: "https://www.typescriptlang.org" },
  { name: "Vite", license: "MIT", url: "https://vite.dev" },
  { name: "Bun", license: "MIT", url: "https://bun.sh" },
  { name: "puppeteer-core", license: "Apache-2.0", url: "https://pptr.dev" },
  { name: "pngjs", license: "MIT", url: "https://github.com/pngjs/pngjs" },
  { name: "oxlint", license: "MIT", url: "https://oxc.rs" },
  { name: "oxfmt", license: "MIT", url: "https://oxc.rs" },
];

const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );

const p = (s: string): string => `<p>${escapeHtml(s)}</p>`;
const h = (s: string): string => `<h3>${escapeHtml(s)}</h3>`;

function creditRow(c: Credit): string {
  return (
    "<li>" +
    `<span class="nm">${escapeHtml(c.name)}</span>` +
    `<span class="lic">${escapeHtml(c.license)}</span>` +
    (c.copyright ? `<span class="cr">${escapeHtml(c.copyright)}</span>` : "") +
    `<span class="url">${escapeHtml(c.url)}</span>` +
    "</li>"
  );
}

/**
 * The whole panel, for a host's `.bs-opts` column. The scroll box is a real focus
 * stop; the host drives arrows and the pad (the `about` branch in ui/menu.ts).
 */
export function aboutMarkup(): string {
  return (
    `<h2>${escapeHtml(t("menu.about"))}</h2>` +
    '<div class="about" tabindex="0" role="region" ' +
    `aria-label="${escapeHtml(t("menu.about"))}">` +
    `<p class="lead">${escapeHtml(t("about.lead"))}</p>` +
    h(t("about.what")) +
    "<ul>" +
    `<li>${escapeHtml(t("about.what.1"))}</li>` +
    `<li>${escapeHtml(t("about.what.2"))}</li>` +
    `<li>${escapeHtml(t("about.what.3"))}</li>` +
    `<li>${escapeHtml(t("about.what.4"))}</li>` +
    "</ul>" +
    h(t("about.ai")) +
    p(t("about.ai.body")) +
    h(t("about.credits")) +
    p(t("about.credits.body")) +
    h(t("about.licenses")) +
    p(t("about.licenses.shipped")) +
    `<ul class="credits">${SHIPPED.map(creditRow).join("")}</ul>` +
    p(t("about.licenses.tools")) +
    `<ul class="credits">${TOOLS.map(creditRow).join("")}</ul>` +
    "</div>"
  );
}
