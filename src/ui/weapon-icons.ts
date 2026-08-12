/**
 * Weapon and blueprint icons — one atlas, positioned by CSS (issue #74). Packed by
 * tools/pack-weapon-icons.mjs; that tool and this file restate the ORDER, so keep
 * them in step. Imported, not in `public/`, for the `base:'./'` reason.
 */
import atlasUrl from './weapons.webp';

/** Mirrors tools/pack-weapon-icons.mjs. */
export const WEAPON_ICONS = [
  'largeSword', 'oneHandedSword', 'bow', 'scythe', 'dagger',
  'largeSwordBlueprint', 'oneHandedSwordBlueprint', 'bowBlueprint',
  'scytheBlueprint', 'daggerBlueprint',
] as const;
export type WeaponIcon = (typeof WEAPON_ICONS)[number];

const COLS = 5;
const ROWS = 2;

export const ATLAS_URL: string = atlasUrl;

/** PER CENT so a slot can be any size: at `cols x 100%`, `i/(cols-1)` hits tile `i`. */
export function weaponIconStyle(icon: WeaponIcon): string {
  const i = WEAPON_ICONS.indexOf(icon);
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  return `background-image:url(${atlasUrl});` +
    `background-size:${COLS * 100}% ${ROWS * 100}%;` +
    `background-position:${(col / (COLS - 1)) * 100}% ${(row / (ROWS - 1)) * 100}%;` +
    `background-repeat:no-repeat`;
}

export function isWeaponIcon(s: string): s is WeaponIcon {
  return (WEAPON_ICONS as readonly string[]).includes(s);
}
