import type { ElementType, Locomotion } from '../core/types';

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

/**
 * WHERE a beast can go, as a glyph — the second half of its type.
 *
 * A SEPARATE ICON FROM THE ELEMENT, and that split is the whole point. Element
 * is what a beast hits with and it is already the badge's colour and shape;
 * locomotion is what a beast is FOR, and it is the only thing on the card that
 * answers the question a player actually has in front of a lake ("can this one
 * take me across"). Two glyphs on one badge read as a pair of types the way a
 * dual-typed creature does in any collectathon — Rivotter is water AND
 * amphibious, and both halves are on screen.
 *
 * Drawn at 24x24 like every other icon here but displayed at ~11px in a corner
 * pip, so each is one silhouette with no interior detail: a paw, a wing, a
 * wave, and — for amphibious — the wave with the paw standing in it, which is
 * the one combination that has to read at a glance without a caption.
 */
export const LOCOMOTION_ICONS: Record<Locomotion, string> = {
  ground: svg(
    // A paw: pad plus four toes. Toes clear of the pad so they survive the
    // downscale as separate blobs instead of fusing into a lump.
    `<path fill="currentColor" d="M12 12.4c3.1 0 5.6 2.4 5.6 4.8 0 2-1.7 3.2-3.5 3.2-.9 0-1.4-.4-2.1-.4s-1.2.4-2.1.4c-1.8 0-3.5-1.2-3.5-3.2 0-2.4 2.5-4.8 5.6-4.8Z"/>` +
    `<ellipse fill="currentColor" cx="5.6" cy="12" rx="2.3" ry="2.9"/>` +
    `<ellipse fill="currentColor" cx="18.4" cy="12" rx="2.3" ry="2.9"/>` +
    `<ellipse fill="currentColor" cx="9.4" cy="6.5" rx="2.2" ry="3"/>` +
    `<ellipse fill="currentColor" cx="14.6" cy="6.5" rx="2.2" ry="3"/>`,
  ),
  flying: svg(
    // A GULL — two arcs meeting at the shoulders — and it is the second shape
    // tried here. The first was a filled outstretched wing pair with a bar
    // under it, which is a fine drawing at 24px and at the 11px this is
    // actually displayed at (captured, shots/_hud-loco-zoom.png) its two lobes
    // merged into one chevron over a line: it read as a "collapse" caret, not
    // as flight. Two open strokes cannot merge, because the gap between them IS
    // the glyph.
    `<g fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" ` +
    `stroke-linejoin="round">` +
    `<path d="M2.2 15.4C5 8.6 8.6 8.2 12 13.8 15.4 8.2 19 8.6 21.8 15.4"/>` +
    `</g>`,
  ),
  swimming: svg(
    // Three stacked swells. Stacked rather than one big wave because a single
    // curve at this size is indistinguishable from the water ELEMENT glyph
    // beside it, and these two are always shown together.
    `<g fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">` +
    `<path d="M2.6 7.4c2-2 3.4-2 5.4 0s3.4 2 5.4 0 3.4-2 5.4 0l2.6 0"/>` +
    `<path d="M2.6 13c2-2 3.4-2 5.4 0s3.4 2 5.4 0 3.4-2 5.4 0l2.6 0"/>` +
    `<path d="M2.6 18.6c2-2 3.4-2 5.4 0s3.4 2 5.4 0 3.4-2 5.4 0l2.6 0"/>` +
    `</g>`,
  ),
  amphibious: svg(
    // The paw standing in the water: the two silhouettes above, composed. The
    // waterline crosses under the pad, which is what says "both" rather than
    // "either".
    //
    // The paw is drawn with TWO toes rather than four. Four is right on the
    // ground glyph, which has the whole 24x24 to itself; here the paw only gets
    // the top half, so four toes at 11px are four sub-pixel dots that grey the
    // shape out instead of reading as toes.
    `<path fill="currentColor" d="M12 5.4c3 0 5.4 2.4 5.4 4.7 0 1.9-1.6 3.1-3.4 3.1-.8 0-1.3-.4-2-.4s-1.2.4-2 .4c-1.8 0-3.4-1.2-3.4-3.1C6.6 7.8 9 5.4 12 5.4Z"/>` +
    `<ellipse fill="currentColor" cx="6.1" cy="4.6" rx="2.2" ry="2.8"/>` +
    `<ellipse fill="currentColor" cx="17.9" cy="4.6" rx="2.2" ry="2.8"/>` +
    `<g fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round">` +
    `<path d="M2.2 17.4c2.2-2.2 3.8-2.2 6 0s3.8 2.2 6 0 3.8-2.2 6 0"/>` +
    `<path d="M2.2 21.8c2.2-2.2 3.8-2.2 6 0s3.8 2.2 6 0 3.8-2.2 6 0"/>` +
    `</g>`,
  ),
};

export function locomotionIcon(loco: Locomotion): string {
  return LOCOMOTION_ICONS[loco];
}

/**
 * A TAMING ORB, by tier — a glass sphere with a banded seam and one notch per
 * tier.
 *
 * ONE DRAWING WITH A PARAMETER, not four glyphs. The four orbs differ in exactly
 * one thing and the icon should differ in exactly that thing; four hand-drawn
 * spheres would be four chances for them to stop being the same object.
 *
 * THE NOTCHES ARE THE TIER, and the colour is not. The item's own `color`
 * reaches this through `currentColor` (see `iconHtml` in ui/inventory.ts), so a
 * Master Orb is black-on-dark in a dark theme and a red and a violet orb are one
 * hue apart at a glance — none of which a player should have to rely on. Counting
 * notches works in greyscale, at a distance, and for anyone who cannot tell the
 * two ends of that ramp apart. The band they sit on is what keeps them reading as
 * markings on a sphere rather than as four loose dots.
 *
 * Drawn at 24x24 and displayed in an inventory slot at 56-72 CSS px — several
 * times the 11px the locomotion pips get — so the seam, the notches and the
 * highlight all survive, and this needs none of that file's silhouette-only
 * discipline.
 */
function orbIcon(tier: number): string {
  const notches = Math.max(1, Math.min(4, Math.round(tier)));
  // Spread across the band's usable width, symmetric about the centre: a lone
  // notch sits in the middle, four sit evenly and none touches the rim.
  const span = 9.6;
  const marks = Array.from({ length: notches }, (_, i) => {
    const t = notches === 1 ? 0 : i / (notches - 1) - 0.5;
    return `<rect fill="currentColor" x="${(12 + t * span - 0.85).toFixed(2)}" y="10.5" width="1.7" height="3" rx="0.5"/>`;
  }).join('');
  return svg(
    // The glass. An outline rather than a filled disc so the notches read as
    // marks ON it — filled, they would be holes punched out of a lozenge.
    `<circle fill="none" stroke="currentColor" stroke-width="2" cx="12" cy="12" r="8.8"/>` +
    // The seam the two halves meet on, broken either side of the notches.
    `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">` +
    `<path d="M3.4 12h3.1M17.5 12h3.1"/>` +
    `</g>` +
    marks +
    // The catch-light, the one piece that says "glass" rather than "ring".
    `<path fill="rgba(255,255,255,.55)" d="M8.1 6.9a6.4 6.4 0 0 1 3.3-1.6.9.9 0 0 1 .3 1.8 4.6 4.6 0 0 0-2.4 1.1.9.9 0 0 1-1.2-1.3Z"/>`,
  );
}

/**
 * The four orbs, keyed by `ItemDef.orbTier`. Built once at module load — the
 * inventory rebuilds its rows on every action, and re-running the arithmetic
 * above per row would be work nobody asked for.
 */
export const ORB_ICONS: Readonly<Record<number, string>> = {
  1: orbIcon(1), 2: orbIcon(2), 3: orbIcon(3), 4: orbIcon(4),
};

/** The glyph for an orb of this tier, falling back to the plainest. */
export function tameOrbIcon(tier: number | undefined): string {
  return ORB_ICONS[tier ?? 1] ?? ORB_ICONS[1];
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

/**
 * Three bars — the menu button in the HUD's top-left corner.
 *
 * The burger, drawn as three separate round-capped strokes rather than as one
 * path, because that is the shape a player recognises from every other piece of
 * software they use and this is a button whose whole job is to be recognised.
 */
export const BURGER_ICON = svg(
  `<g fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">` +
  `<path d="M4 7h16M4 12h16M4 17h16"/>` +
  `</g>`,
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
