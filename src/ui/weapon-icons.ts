/**
 * THE WEAPON AND BLUEPRINT ICONS — one atlas, positioned by CSS.
 *
 * Issue #74's art, repacked by tools/pack-weapon-icons.mjs into a 5x2 grid of
 * 128px tiles: weapons on the top row, the same five shapes as blueprints
 * underneath. That tool holds the source rects and the reasoning; this file is
 * only the reader, and the two restate the ORDER, so keep them in step.
 *
 * NOTHING IS SLICED AT RUNTIME, which is the difference from ui/cursor.ts. A CSS
 * cursor needs one `url()` per state, so that file has to cut sixteen data URIs
 * on a canvas and everything before the decode resolves shows the system
 * pointer. An inventory slot is an ordinary element: `background-image` plus a
 * `background-position` off this table is the whole implementation, the browser
 * does the cutting, and the icons are on the panel's first paint with no await
 * and no canvas.
 *
 * THE ASSET RULE. AGENTS.md's exception list gains a third entry, on the same
 * terms as the title poster and the cursor sheet: 2D chrome the renderer never
 * touches, where the art IS the design. Everything the RENDERER draws is still
 * generated in code — a weapon's voxel model, when the forge ships, will be.
 * Imported rather than dropped in a `public/` folder, for the `base:'./'`
 * reason spelled out on the menu art.
 */
import atlasUrl from './weapons.webp';

/** Tile order in the atlas, five to a row. Mirrors tools/pack-weapon-icons.mjs. */
export const WEAPON_ICONS = [
  'largeSword', 'oneHandedSword', 'bow', 'scythe', 'dagger',
  'largeSwordBlueprint', 'oneHandedSwordBlueprint', 'bowBlueprint',
  'scytheBlueprint', 'daggerBlueprint',
] as const;
export type WeaponIcon = (typeof WEAPON_ICONS)[number];

const COLS = 5;
const ROWS = 2;

export const ATLAS_URL: string = atlasUrl;

/**
 * The CSS an icon needs, as inline style text.
 *
 * `background-size` is expressed as a PERCENTAGE of the element rather than in
 * pixels so a slot can be any size — the phone media query shrinks them and the
 * detail pane blows one up to four times a slot, and neither has to know the
 * tile is 128px. `background-position` is the same trick: with a background
 * sized to `cols x 100%`, position `i/(cols-1)` of the way across lands on tile
 * `i` exactly, which is the one bit of arithmetic here that is not obvious.
 */
export function weaponIconStyle(icon: WeaponIcon): string {
  const i = WEAPON_ICONS.indexOf(icon);
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  return `background-image:url(${atlasUrl});` +
    `background-size:${COLS * 100}% ${ROWS * 100}%;` +
    `background-position:${(col / (COLS - 1)) * 100}% ${(row / (ROWS - 1)) * 100}%;` +
    `background-repeat:no-repeat`;
}

/** Type guard, for an item definition that carries an icon name from data. */
export function isWeaponIcon(s: string): s is WeaponIcon {
  return (WEAPON_ICONS as readonly string[]).includes(s);
}
