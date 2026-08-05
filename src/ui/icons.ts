import type { ElementType } from '../core/types';

/** Inline SVG icon set: one hand-drawn glyph per element, plus UI icons. */

function svg(inner: string): string {
  return `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${inner}</svg>`;
}

export const ELEMENT_ICONS: Record<ElementType, string> = {
  fire: svg(
    `<path fill="currentColor" d="M12 2c.6 3.3 4.4 4.9 4.4 9a4.9 4.9 0 0 1-1.7 3.8c.25-1.7-.4-3-1.7-3.8.35 2.6-2.2 3.4-2.2 5.5 0 .9.4 1.7 1.1 2.3A5.6 5.6 0 0 1 7.2 13c0-4.4 4.2-6.3 4.8-11Z"/>`,
  ),
  water: svg(
    `<path fill="currentColor" d="M12 2.4S5.7 9.2 5.7 14a6.3 6.3 0 0 0 12.6 0c0-4.8-6.3-11.6-6.3-11.6Z"/>` +
    `<path fill="rgba(255,255,255,.4)" d="M9.1 14.6a.9.9 0 0 1 1.8 0 2.6 2.6 0 0 0 2.6 2.6.9.9 0 0 1 0 1.8 4.4 4.4 0 0 1-4.4-4.4Z"/>`,
  ),
  grass: svg(
    `<path fill="currentColor" d="M20.5 3.5C10 3.5 4 9.4 4 16.6c0 1.2.2 2.3.6 3.4 1.6-6.9 5.6-11.4 11.6-13.9-5.2 3.5-8.6 8.4-9.6 14.4.8.3 1.7.5 2.6.5 7.4 0 11.3-8 11.3-17.5Z"/>`,
  ),
  electric: svg(
    `<path fill="currentColor" d="M13.2 2 4.6 13.4h5.9L8.9 22l9.9-12.2h-6L13.2 2Z"/>`,
  ),
  ice: svg(
    `<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">` +
    `<path d="M12 2.8v18.4M4 7.4l16 9.2M4 16.6l16-9.2"/>` +
    `<path d="M9.4 4.2 12 6.4l2.6-2.2M9.4 19.8 12 17.6l2.6 2.2M3.9 11 7 11.9l.2-3.4M20.1 13 17 12.1l-.2 3.4"/>` +
    `</g>`,
  ),
  rock: svg(
    `<path fill="currentColor" d="M12 2.6 20.3 8l-2.9 11.3H6.6L3.7 8 12 2.6Z"/>` +
    `<path fill="rgba(0,0,0,.22)" d="M12 2.6 20.3 8l-2.9 11.3h-4.2L12 10.4 6.2 8.9 12 2.6Z"/>`,
  ),
  wind: svg(
    `<g fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round">` +
    `<path d="M3 8.2h10.4a3 3 0 1 0-2.9-3.8"/>` +
    `<path d="M3 13h14.8a3.1 3.1 0 1 1-3 3.9"/>` +
    `<path d="M3 17.8h6.6"/>` +
    `</g>`,
  ),
  shadow: svg(
    `<path fill="currentColor" d="M14.8 2.6a9.7 9.7 0 1 0 6.6 15.7A8.6 8.6 0 0 1 10.3 7a8.6 8.6 0 0 1 4.5-4.4Z"/>` +
    `<circle fill="rgba(255,255,255,.5)" cx="17.4" cy="5.6" r="1.1"/>`,
  ),
  light: svg(
    `<circle fill="currentColor" cx="12" cy="12" r="4.2"/>` +
    `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">` +
    `<path d="M12 2.4v2.8M12 18.8v2.8M2.4 12h2.8M18.8 12h2.8M5.2 5.2l2 2M16.8 16.8l2 2M18.8 5.2l-2 2M7.2 16.8l-2 2"/>` +
    `</g>`,
  ),
  dragon: svg(
    `<path fill="currentColor" d="M12 1.8 18.4 8l-2.1 4 2.1 4L12 22.2 5.6 16l2.1-4-2.1-4L12 1.8Z"/>` +
    `<path fill="rgba(0,0,0,.24)" d="M12 1.8 18.4 8l-2.1 4 2.1 4L12 22.2V1.8Z"/>`,
  ),
};

export function elementIcon(el: ElementType): string {
  return ELEMENT_ICONS[el];
}

/** Faceted crystal shard (currency). */
export const SHARD_ICON = svg(
  `<path fill="currentColor" d="M7.2 2.2h9.6L21 7.6 12 21.8 3 7.6l4.2-5.4Z"/>` +
  `<path fill="none" stroke="rgba(255,255,255,.42)" stroke-width="1.15" stroke-linejoin="round" ` +
  `d="M7.2 2.2 12 7.6l4.8-5.4M3 7.6h18M12 7.6v13.4"/>`,
);

export const CHECK_ICON = svg(
  `<path fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" d="M4.4 12.6l5 5L19.6 7.2"/>`,
);

export const CLOSE_ICON = svg(
  `<path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" d="M6 6l12 12M18 6 6 18"/>`,
);

/**
 * The RIGHT mouse button, as a small glyph for a control bound to it.
 *
 * A body outline with the right half filled, which is the one drawing of a
 * mouse that says WHICH button without a caption — the inventory prints it
 * beside an action instead of the sentence "right-click to equip".
 */
export const RMB_ICON = svg(
  `<rect x="6.5" y="2.5" width="11" height="19" rx="5.5" fill="none" stroke="currentColor" stroke-width="1.8"/>` +
  `<path fill="currentColor" d="M12.6 3.4h.9a4 4 0 0 1 4 4v3.4h-4.9Z"/>` +
  `<path fill="none" stroke="currentColor" stroke-width="1.4" d="M12 3.2v7.6"/>`,
);
